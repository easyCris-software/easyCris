use std::f32::consts::TAU;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use uuid::Uuid;

const E2E_NATIVE_AUDIO_SAMPLE_RATE: u32 = 48_000;
const E2E_NATIVE_AUDIO_CHANNEL_COUNT: u32 = 2;
const E2E_NATIVE_AUDIO_CHUNK_MS: u32 = 20;
const NATIVE_AUDIO_FORMAT_F32: u32 = 1;
const E2E_NATIVE_AUDIO_SOURCE_KIND: &str = "e2e-native-tone";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NativeAudioCaptureStartResult {
    pub capture_id: String,
    pub channel_count: u32,
    pub sample_rate: u32,
    pub source_kind: String,
    pub capture_sample_rate: u32,
    pub rubato_resampler_active: bool,
    pub output_frames_per_chunk: u32,
}

pub struct NativeAudioCaptureHandle {
    start_result: NativeAudioCaptureStartResult,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for NativeAudioCaptureHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeAudioCaptureHandle")
            .field("start_result", &self.start_result)
            .finish_non_exhaustive()
    }
}

pub(crate) fn encode_native_audio_packet(
    sample_rate: u32,
    channel_count: u32,
    frames: u32,
    samples: &[f32],
) -> Vec<u8> {
    let mut packet = Vec::with_capacity(16 + samples.len() * 4);
    packet.extend_from_slice(&sample_rate.to_le_bytes());
    packet.extend_from_slice(&channel_count.to_le_bytes());
    packet.extend_from_slice(&frames.to_le_bytes());
    packet.extend_from_slice(&NATIVE_AUDIO_FORMAT_F32.to_le_bytes());
    for sample in samples {
        packet.extend_from_slice(&sample.to_le_bytes());
    }
    packet
}

impl NativeAudioCaptureHandle {
    pub(crate) fn new(
        start_result: NativeAudioCaptureStartResult,
        stop: Arc<AtomicBool>,
        thread: JoinHandle<()>,
    ) -> Self {
        Self {
            start_result,
            stop,
            thread: Some(thread),
        }
    }

    pub fn capture_id(&self) -> &str {
        &self.start_result.capture_id
    }

    pub fn start_result(&self) -> NativeAudioCaptureStartResult {
        self.start_result.clone()
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn start_e2e_native_audio_tone_capture(
    frequency_hz: f32,
    on_audio: Channel<InvokeResponseBody>,
) -> Result<NativeAudioCaptureHandle, String> {
    if !frequency_hz.is_finite() || frequency_hz <= 0.0 {
        return Err("Native E2E audio tone frequency must be positive".to_string());
    }

    let capture_id = Uuid::new_v4().to_string();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let thread_capture_id = capture_id.clone();
    let thread = thread::Builder::new()
        .name("easycris-e2e-native-audio".to_string())
        .spawn(move || {
            run_e2e_tone_loop(frequency_hz, on_audio, thread_stop);
            log::debug!("E2E native audio capture stopped: {thread_capture_id}");
        })
        .map_err(|error| format!("Failed to start E2E native audio thread: {error}"))?;

    Ok(NativeAudioCaptureHandle::new(
        NativeAudioCaptureStartResult {
            capture_id,
            channel_count: E2E_NATIVE_AUDIO_CHANNEL_COUNT,
            sample_rate: E2E_NATIVE_AUDIO_SAMPLE_RATE,
            source_kind: E2E_NATIVE_AUDIO_SOURCE_KIND.to_string(),
            capture_sample_rate: E2E_NATIVE_AUDIO_SAMPLE_RATE,
            rubato_resampler_active: false,
            output_frames_per_chunk: frames_per_e2e_audio_chunk(),
        },
        stop,
        thread,
    ))
}

fn run_e2e_tone_loop(
    frequency_hz: f32,
    on_audio: Channel<InvokeResponseBody>,
    stop: Arc<AtomicBool>,
) {
    let frames_per_chunk = frames_per_e2e_audio_chunk();
    let chunk_duration = Duration::from_millis(E2E_NATIVE_AUDIO_CHUNK_MS.into());
    let mut sample_index: u64 = 0;
    let mut next_tick = Instant::now();

    while !stop.load(Ordering::Relaxed) {
        let packet = encode_e2e_tone_packet(frequency_hz, frames_per_chunk, &mut sample_index);
        if on_audio.send(InvokeResponseBody::Raw(packet)).is_err() {
            break;
        }
        next_tick += chunk_duration;
        let now = Instant::now();
        if next_tick > now {
            thread::sleep(next_tick - now);
        } else {
            next_tick = now;
        }
    }
}

fn frames_per_e2e_audio_chunk() -> u32 {
    E2E_NATIVE_AUDIO_SAMPLE_RATE.saturating_mul(E2E_NATIVE_AUDIO_CHUNK_MS) / 1_000
}

fn encode_e2e_tone_packet(frequency_hz: f32, frames: u32, sample_index: &mut u64) -> Vec<u8> {
    let channel_count = E2E_NATIVE_AUDIO_CHANNEL_COUNT;
    let mut samples = Vec::with_capacity(frames as usize * channel_count as usize);
    for _ in 0..frames {
        let phase =
            (*sample_index as f32 * frequency_hz * TAU) / E2E_NATIVE_AUDIO_SAMPLE_RATE as f32;
        let sample = phase.sin() * 0.25;
        for _ in 0..channel_count {
            samples.push(sample);
        }
        *sample_index = sample_index.saturating_add(1);
    }
    encode_native_audio_packet(
        E2E_NATIVE_AUDIO_SAMPLE_RATE,
        channel_count,
        frames,
        &samples,
    )
}

#[cfg(test)]
mod tests {
    use super::{encode_e2e_tone_packet, NATIVE_AUDIO_FORMAT_F32};

    #[test]
    fn e2e_tone_packet_contains_pcm_header_and_interleaved_f32_samples() {
        let mut sample_index = 0;
        let packet = encode_e2e_tone_packet(440.0, 8, &mut sample_index);

        assert_eq!(u32::from_le_bytes(packet[0..4].try_into().unwrap()), 48_000);
        assert_eq!(u32::from_le_bytes(packet[4..8].try_into().unwrap()), 2);
        assert_eq!(u32::from_le_bytes(packet[8..12].try_into().unwrap()), 8);
        assert_eq!(
            u32::from_le_bytes(packet[12..16].try_into().unwrap()),
            NATIVE_AUDIO_FORMAT_F32
        );
        assert_eq!(packet.len(), 16 + 8 * 2 * 4);
        let left_frame_1 = f32::from_le_bytes(packet[24..28].try_into().unwrap());
        let right_frame_1 = f32::from_le_bytes(packet[28..32].try_into().unwrap());
        assert_ne!(left_frame_1, 0.0);
        assert_eq!(left_frame_1, right_frame_1);
        assert_eq!(sample_index, 8);
    }
}
