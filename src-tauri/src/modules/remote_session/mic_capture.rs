#[cfg(windows)]
mod platform {
    use std::borrow::Cow;
    use std::collections::VecDeque;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::thread;

    use rubato::audioadapter_buffers::direct::SequentialSliceOfVecs;
    use rubato::{
        Async, FixedAsync, Resampler, SincInterpolationParameters, SincInterpolationType,
        WindowFunction,
    };
    use sonora::config::EchoCanceller;
    use sonora::{AudioProcessing, Config, StreamConfig};
    use tauri::ipc::{Channel, InvokeResponseBody};
    use uuid::Uuid;
    use wasapi::{
        initialize_mta, AudioCaptureClient, AudioClient, AudioClientProperties, DeviceEnumerator,
        Direction, Handle, Role, SampleType, StreamCategory, StreamMode, WaveFormat,
    };

    use super::super::audio_capture::{
        encode_native_audio_packet, NativeAudioCaptureHandle, NativeAudioCaptureStartResult,
    };

    const NATIVE_MIC_SAMPLE_RATE: u32 = 48_000;
    const NATIVE_MIC_CHANNEL_COUNT: u32 = 1;
    const NATIVE_MIC_CHUNK_MS: u32 = 10;
    const NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK: usize =
        (NATIVE_MIC_SAMPLE_RATE as usize * NATIVE_MIC_CHUNK_MS as usize) / 1_000;
    const NATIVE_MIC_SOURCE_KIND: &str = "wasapi-mic-only";
    const NATIVE_MIC_AEC_SOURCE_KIND: &str = "wasapi-mic-hw-aec";
    const NATIVE_MIC_SOFTWARE_AEC_SOURCE_KIND: &str = "wasapi-mic-sw-aec";
    const NATIVE_MIC_SOFTWARE_AEC_RENDER_QUEUE_CAPACITY: usize = 8;
    const NATIVE_MIC_SOFTWARE_AEC_MAX_DELAY_MS: i32 = 500;

    struct NativeMicSetup {
        audio_client: AudioClient,
        capture_client: AudioCaptureClient,
        event: Handle,
        block_align: usize,
        buffer_frame_count: u32,
        capture_sample_rate: u32,
        source_kind: &'static str,
        software_aec: Option<SoftwareAecProcessor>,
    }

    struct NativeMicStartMetadata {
        source_kind: String,
        capture_sample_rate: u32,
        rubato_resampler_active: bool,
    }

    struct NativeMicPacketizer {
        normalizer: NativeMicNormalizer,
        output_queue: VecDeque<f32>,
    }

    enum NativeMicNormalizer {
        Passthrough,
        Resample {
            resampler: Async<f32>,
            input_frames_per_chunk: usize,
        },
    }

    struct SoftwareAecProcessor {
        audio_client: AudioClient,
        capture_client: AudioCaptureClient,
        block_align: usize,
        byte_queue: VecDeque<u8>,
        render_queue: VecDeque<Vec<f32>>,
        core: SoftwareAecCore,
        warned: bool,
    }

    struct SoftwareAecCore {
        apm: AudioProcessing,
        render_out: Vec<f32>,
        capture_out: Vec<f32>,
    }

    impl SoftwareAecCore {
        fn new(stream_delay_ms: i32) -> Result<Self, String> {
            let stream = StreamConfig::new(NATIVE_MIC_SAMPLE_RATE, NATIVE_MIC_CHANNEL_COUNT as u16);
            let config = Config {
                echo_canceller: Some(EchoCanceller::default()),
                ..Default::default()
            };
            let mut apm = AudioProcessing::builder()
                .config(config)
                .capture_config(stream)
                .render_config(stream)
                .build();
            apm.set_stream_delay_ms(stream_delay_ms)
                .map_err(|error| format!("Failed to configure software AEC delay: {error}"))?;
            Ok(Self {
                apm,
                render_out: vec![0.0; NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK],
                capture_out: vec![0.0; NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK],
            })
        }

        #[cfg(test)]
        fn stream_delay_ms(&self) -> i32 {
            self.apm.stream_delay_ms()
        }

        fn process(
            &mut self,
            render_samples: &[f32],
            capture_samples: &[f32],
        ) -> Result<Vec<f32>, String> {
            if render_samples.len() != NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK {
                return Err(format!(
                    "AEC render frame had {} samples, expected {}",
                    render_samples.len(),
                    NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK
                ));
            }
            if capture_samples.len() != NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK {
                return Err(format!(
                    "AEC capture frame had {} samples, expected {}",
                    capture_samples.len(),
                    NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK
                ));
            }
            self.apm
                .process_render_f32(&[render_samples], &mut [&mut self.render_out])
                .map_err(|error| format!("Failed to process AEC render reference: {error}"))?;
            self.apm
                .process_capture_f32(&[capture_samples], &mut [&mut self.capture_out])
                .map_err(|error| format!("Failed to process AEC capture frame: {error}"))?;
            Ok(self.capture_out.clone())
        }
    }

    impl SoftwareAecProcessor {
        fn process_capture_frame(&mut self, capture_samples: &[f32]) -> Vec<f32> {
            match self.try_process_capture_frame(capture_samples) {
                Ok(samples) => {
                    self.warned = false;
                    samples
                }
                Err(error) => handle_software_aec_error(&mut self.warned, &error, capture_samples),
            }
        }

        fn try_process_capture_frame(
            &mut self,
            capture_samples: &[f32],
        ) -> Result<Vec<f32>, String> {
            self.capture_client
                .read_from_device_to_deque(&mut self.byte_queue)
                .map_err(|error| {
                    format!("Failed to read Windows speaker loopback samples: {error}")
                })?;
            let bytes_per_chunk = self.block_align * NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK;
            while self.byte_queue.len() >= bytes_per_chunk {
                let chunk: Vec<u8> = self.byte_queue.drain(..bytes_per_chunk).collect();
                let samples = pcm_f32_samples_from_bytes(&chunk);
                enqueue_render_reference_frame(&mut self.render_queue, samples);
            }
            let render_samples = next_render_reference_frame(&mut self.render_queue);
            self.core.process(&render_samples, capture_samples)
        }

        fn stop(&self) {
            if let Err(error) = self.audio_client.stop_stream() {
                log::warn!("Failed to stop Windows speaker loopback capture cleanly: {error}");
            }
        }
    }

    impl NativeMicPacketizer {
        fn new(capture_sample_rate: u32, input_frames_per_chunk: usize) -> Result<Self, String> {
            Ok(Self {
                normalizer: NativeMicNormalizer::new(capture_sample_rate, input_frames_per_chunk)?,
                output_queue: VecDeque::with_capacity(NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK * 4),
            })
        }

        fn push_input(&mut self, samples: &[f32]) -> Result<Vec<Vec<f32>>, String> {
            let normalized = self.normalizer.normalize(samples)?;
            self.output_queue.extend(normalized.iter().copied());
            let mut chunks = Vec::new();
            while self.output_queue.len() >= NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK {
                chunks.push(
                    self.output_queue
                        .drain(..NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK)
                        .collect(),
                );
            }
            Ok(chunks)
        }
    }

    impl NativeMicNormalizer {
        fn new(capture_sample_rate: u32, input_frames_per_chunk: usize) -> Result<Self, String> {
            if capture_sample_rate == NATIVE_MIC_SAMPLE_RATE {
                return Ok(Self::Passthrough);
            }

            let params = SincInterpolationParameters {
                sinc_len: 64,
                f_cutoff: 0.95,
                interpolation: SincInterpolationType::Cubic,
                oversampling_factor: 16,
                window: WindowFunction::BlackmanHarris2,
            };
            let resampler = Async::<f32>::new_sinc(
                NATIVE_MIC_SAMPLE_RATE as f64 / capture_sample_rate as f64,
                1.0,
                &params,
                input_frames_per_chunk,
                NATIVE_MIC_CHANNEL_COUNT as usize,
                FixedAsync::Input,
            )
            .map_err(|error| {
                format!(
                    "Failed to create microphone resampler {capture_sample_rate}->{}: {error}",
                    NATIVE_MIC_SAMPLE_RATE
                )
            })?;
            Ok(Self::Resample {
                resampler,
                input_frames_per_chunk,
            })
        }

        fn normalize<'a>(&mut self, samples: &'a [f32]) -> Result<Cow<'a, [f32]>, String> {
            match self {
                Self::Passthrough => Ok(Cow::Borrowed(samples)),
                Self::Resample {
                    resampler,
                    input_frames_per_chunk,
                } => {
                    let input = vec![samples.to_vec()];
                    let adapter = SequentialSliceOfVecs::new(&input, 1, *input_frames_per_chunk)
                        .map_err(|error| format!("Failed to adapt microphone samples: {error}"))?;
                    resampler
                        .process(&adapter, 0, None)
                        .map(|output| Cow::Owned(output.take_data()))
                        .map_err(|error| format!("Failed to resample microphone samples: {error}"))
                }
            }
        }
    }

    pub fn start_native_mic_capture(
        on_audio: Channel<InvokeResponseBody>,
    ) -> Result<NativeAudioCaptureHandle, String> {
        let capture_id = Uuid::new_v4().to_string();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread_capture_id = capture_id.clone();
        let (start_tx, start_rx) = std::sync::mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name("easycris-native-mic-audio".to_string())
            .spawn(move || {
                let result = run_native_mic_loop(on_audio, thread_stop, start_tx);
                if let Err(error) = result {
                    log::warn!("Native mic capture stopped with error: {error}");
                }
                log::debug!("Native mic capture stopped: {thread_capture_id}");
            })
            .map_err(|error| format!("Failed to start native mic audio thread: {error}"))?;

        let metadata = match start_rx.recv() {
            Ok(Ok(metadata)) => metadata,
            Ok(Err(error)) => {
                let _ = thread.join();
                return Err(error);
            }
            Err(error) => {
                let _ = thread.join();
                return Err(format!(
                    "Native mic audio thread exited before startup: {error}"
                ));
            }
        };

        Ok(NativeAudioCaptureHandle::new(
            NativeAudioCaptureStartResult {
                capture_id,
                channel_count: NATIVE_MIC_CHANNEL_COUNT,
                sample_rate: NATIVE_MIC_SAMPLE_RATE,
                source_kind: metadata.source_kind,
                capture_sample_rate: metadata.capture_sample_rate,
                rubato_resampler_active: metadata.rubato_resampler_active,
                output_frames_per_chunk: NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK as u32,
            },
            stop,
            thread,
        ))
    }

    fn run_native_mic_loop(
        on_audio: Channel<InvokeResponseBody>,
        stop: Arc<AtomicBool>,
        start_tx: std::sync::mpsc::SyncSender<Result<NativeMicStartMetadata, String>>,
    ) -> Result<(), String> {
        let setup = match setup_native_mic_capture() {
            Ok(setup) => setup,
            Err(error) => {
                let _ = start_tx.send(Err(error.clone()));
                return Err(error);
            }
        };
        let metadata = NativeMicStartMetadata {
            source_kind: setup.source_kind.to_string(),
            capture_sample_rate: setup.capture_sample_rate,
            rubato_resampler_active: setup.capture_sample_rate != NATIVE_MIC_SAMPLE_RATE,
        };
        let _ = start_tx.send(Ok(metadata));
        run_native_mic_capture_loop(setup, on_audio, stop)
    }

    fn setup_native_mic_capture() -> Result<NativeMicSetup, String> {
        initialize_mta()
            .ok()
            .map_err(|error| format!("Failed to initialize WASAPI COM: {error}"))?;
        let enumerator =
            DeviceEnumerator::new().map_err(|error| format!("WASAPI device error: {error}"))?;
        let input_device = enumerator
            .get_default_device_for_role(&Direction::Capture, &Role::Communications)
            .or_else(|_| enumerator.get_default_device(&Direction::Capture))
            .map_err(|error| format!("No Windows microphone device is available: {error}"))?;

        let mut audio_client = input_device
            .get_iaudioclient()
            .map_err(|error| format!("Failed to open Windows microphone client: {error}"))?;
        audio_client
            .set_properties(
                AudioClientProperties::new().set_category(StreamCategory::Communications),
            )
            .map_err(|error| format!("Failed to set microphone stream category: {error}"))?;

        let capture_sample_rate = audio_client
            .get_mixformat()
            .map(|format| format.get_samplespersec())
            .unwrap_or(NATIVE_MIC_SAMPLE_RATE);
        let desired_format = WaveFormat::new(
            32,
            32,
            &SampleType::Float,
            capture_sample_rate as usize,
            NATIVE_MIC_CHANNEL_COUNT as usize,
            None,
        );
        let block_align = desired_format.get_blockalign() as usize;
        let (_, capture_period_hns) = audio_client
            .get_device_period()
            .map_err(|error| format!("Failed to read microphone device period: {error}"))?;
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: capture_period_hns,
        };
        audio_client
            .initialize_client(&desired_format, &Direction::Capture, &mode)
            .map_err(|error| format!("Failed to initialize Windows microphone capture: {error}"))?;

        let hardware_aec = enable_hardware_aec(&enumerator, &audio_client);
        let software_aec = if hardware_aec == NATIVE_MIC_AEC_SOURCE_KIND {
            None
        } else {
            match setup_software_aec(&enumerator, capture_period_hns) {
                Ok(processor) => Some(processor),
                Err(error) => {
                    log::warn!("Software AEC unavailable; using native mic without AEC: {error}");
                    None
                }
            }
        };
        let source_kind = if software_aec.is_some() {
            NATIVE_MIC_SOFTWARE_AEC_SOURCE_KIND
        } else {
            hardware_aec
        };
        let event = audio_client
            .set_get_eventhandle()
            .map_err(|error| format!("Failed to create microphone capture event: {error}"))?;
        let buffer_frame_count = audio_client
            .get_buffer_size()
            .map_err(|error| format!("Failed to read microphone buffer size: {error}"))?;
        let capture_client = audio_client
            .get_audiocaptureclient()
            .map_err(|error| format!("Failed to create microphone capture client: {error}"))?;

        audio_client
            .start_stream()
            .map_err(|error| format!("Failed to start Windows microphone capture: {error}"))?;
        Ok(NativeMicSetup {
            audio_client,
            capture_client,
            event,
            block_align,
            buffer_frame_count,
            capture_sample_rate,
            source_kind,
            software_aec,
        })
    }

    fn setup_software_aec(
        enumerator: &DeviceEnumerator,
        capture_period_hns: i64,
    ) -> Result<SoftwareAecProcessor, String> {
        let render_device = enumerator
            .get_default_device(&Direction::Render)
            .map_err(|error| format!("No Windows speaker device is available for AEC: {error}"))?;
        let mut audio_client = render_device
            .get_iaudioclient()
            .map_err(|error| format!("Failed to open Windows speaker loopback client: {error}"))?;
        let desired_format = WaveFormat::new(
            32,
            32,
            &SampleType::Float,
            NATIVE_MIC_SAMPLE_RATE as usize,
            NATIVE_MIC_CHANNEL_COUNT as usize,
            None,
        );
        let block_align = desired_format.get_blockalign() as usize;
        let (_, render_period_hns) = audio_client
            .get_device_period()
            .map_err(|error| format!("Failed to read speaker device period: {error}"))?;
        let mode = StreamMode::PollingShared {
            autoconvert: true,
            buffer_duration_hns: render_period_hns,
        };
        audio_client
            .initialize_client(&desired_format, &Direction::Capture, &mode)
            .map_err(|error| {
                format!("Failed to initialize Windows speaker loopback for AEC: {error}")
            })?;
        let buffer_frame_count = audio_client
            .get_buffer_size()
            .map_err(|error| format!("Failed to read speaker loopback buffer size: {error}"))?;
        let capture_client = audio_client.get_audiocaptureclient().map_err(|error| {
            format!("Failed to create speaker loopback capture client: {error}")
        })?;
        audio_client.start_stream().map_err(|error| {
            format!("Failed to start Windows speaker loopback for AEC: {error}")
        })?;

        let stream_delay_ms = estimate_software_aec_delay_ms(capture_period_hns, render_period_hns);
        Ok(SoftwareAecProcessor {
            audio_client,
            capture_client,
            block_align,
            byte_queue: VecDeque::with_capacity(
                100 * block_align * (1024 + 2 * buffer_frame_count as usize),
            ),
            render_queue: VecDeque::with_capacity(NATIVE_MIC_SOFTWARE_AEC_RENDER_QUEUE_CAPACITY),
            core: SoftwareAecCore::new(stream_delay_ms)?,
            warned: false,
        })
    }

    fn run_native_mic_capture_loop(
        setup: NativeMicSetup,
        on_audio: Channel<InvokeResponseBody>,
        stop: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let NativeMicSetup {
            audio_client,
            capture_client,
            event,
            block_align,
            buffer_frame_count,
            capture_sample_rate,
            mut software_aec,
            ..
        } = setup;
        let mut byte_queue =
            VecDeque::with_capacity(100 * block_align * (1024 + 2 * buffer_frame_count as usize));
        let input_frames_per_chunk = input_frames_per_chunk(capture_sample_rate)
            .ok_or_else(|| format!("Unsupported microphone sample rate: {capture_sample_rate}"))?;
        let bytes_per_chunk = block_align * input_frames_per_chunk;
        let mut packetizer = NativeMicPacketizer::new(capture_sample_rate, input_frames_per_chunk)?;
        while !stop.load(Ordering::Relaxed) {
            capture_client
                .read_from_device_to_deque(&mut byte_queue)
                .map_err(|error| format!("Failed to read Windows microphone samples: {error}"))?;
            while byte_queue.len() >= bytes_per_chunk {
                let chunk: Vec<u8> = byte_queue.drain(..bytes_per_chunk).collect();
                let samples = pcm_f32_samples_from_bytes(&chunk);
                for mut output_samples in packetizer.push_input(&samples)? {
                    if let Some(aec) = software_aec.as_mut() {
                        output_samples = aec.process_capture_frame(&output_samples);
                    }
                    let packet = encode_native_audio_packet(
                        NATIVE_MIC_SAMPLE_RATE,
                        NATIVE_MIC_CHANNEL_COUNT,
                        NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK as u32,
                        &output_samples,
                    );
                    if on_audio.send(InvokeResponseBody::Raw(packet)).is_err() {
                        stop.store(true, Ordering::Relaxed);
                        break;
                    }
                }
                if stop.load(Ordering::Relaxed) {
                    break;
                }
            }
            if stop.load(Ordering::Relaxed) {
                break;
            }
            if event.wait_for_event(100).is_err() {
                continue;
            }
        }
        if let Err(error) = audio_client.stop_stream() {
            log::warn!("Failed to stop Windows microphone capture cleanly: {error}");
        }
        if let Some(aec) = software_aec {
            aec.stop();
        }
        Ok(())
    }

    fn enable_hardware_aec(
        enumerator: &DeviceEnumerator,
        audio_client: &wasapi::AudioClient,
    ) -> &'static str {
        match audio_client.is_aec_supported() {
            Ok(true) => {
                let result = (|| {
                    let output_device = enumerator.get_default_device(&Direction::Render)?;
                    let endpoint_id = output_device.get_id()?;
                    audio_client
                        .get_aec_control()?
                        .set_echo_cancellation_render_endpoint(Some(endpoint_id))?;
                    Ok::<(), wasapi::WasapiError>(())
                })();
                match result {
                    Ok(()) => return NATIVE_MIC_AEC_SOURCE_KIND,
                    Err(error) => {
                        log::warn!(
                            "Windows hardware AEC rejected the default render endpoint: {error}"
                        );
                        match audio_client
                            .get_aec_control()
                            .and_then(|control| control.set_echo_cancellation_render_endpoint(None))
                        {
                            Ok(()) => return NATIVE_MIC_AEC_SOURCE_KIND,
                            Err(fallback_error) => {
                                log::warn!(
                                    "Windows hardware AEC automatic reference selection failed: {fallback_error}"
                                );
                            }
                        }
                    }
                }
            }
            Ok(false) => {}
            Err(error) => {
                log::debug!("Windows hardware AEC support check failed: {error}");
            }
        }
        NATIVE_MIC_SOURCE_KIND
    }

    fn pcm_f32_samples_from_bytes(bytes: &[u8]) -> Vec<f32> {
        bytes
            .chunks_exact(4)
            .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()))
            .collect()
    }

    fn input_frames_per_chunk(sample_rate: u32) -> Option<usize> {
        let frames = sample_rate.checked_mul(NATIVE_MIC_CHUNK_MS)? / 1_000;
        (frames > 0).then_some(frames as usize)
    }

    fn estimate_software_aec_delay_ms(capture_period_hns: i64, render_period_hns: i64) -> i32 {
        (hns_to_ms_ceil(capture_period_hns)
            + hns_to_ms_ceil(render_period_hns)
            + NATIVE_MIC_CHUNK_MS as i32)
            .clamp(0, NATIVE_MIC_SOFTWARE_AEC_MAX_DELAY_MS)
    }

    fn hns_to_ms_ceil(hns: i64) -> i32 {
        if hns <= 0 {
            return 0;
        }
        ((hns + 9_999) / 10_000).min(NATIVE_MIC_SOFTWARE_AEC_MAX_DELAY_MS as i64) as i32
    }

    fn enqueue_render_reference_frame(render_queue: &mut VecDeque<Vec<f32>>, samples: Vec<f32>) {
        // V1 keeps FIFO render/capture alignment. If loopback bursts ahead, drop
        // newest overflow rather than evicting the older frames that are closer
        // to the capture frames about to be processed.
        if render_queue.len() < NATIVE_MIC_SOFTWARE_AEC_RENDER_QUEUE_CAPACITY {
            render_queue.push_back(samples);
        }
    }

    fn next_render_reference_frame(render_queue: &mut VecDeque<Vec<f32>>) -> Vec<f32> {
        render_queue
            .pop_front()
            .unwrap_or_else(|| vec![0.0; NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK])
    }

    fn handle_software_aec_error(
        warned: &mut bool,
        error: &str,
        capture_samples: &[f32],
    ) -> Vec<f32> {
        if !*warned {
            log::warn!("Software AEC failed; passing through native mic audio: {error}");
            *warned = true;
        }
        capture_samples.to_vec()
    }

    #[cfg(test)]
    mod tests {
        use std::collections::VecDeque;

        use super::{
            enqueue_render_reference_frame, estimate_software_aec_delay_ms,
            handle_software_aec_error, next_render_reference_frame, NativeMicPacketizer,
            SoftwareAecCore, NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK,
            NATIVE_MIC_SOFTWARE_AEC_RENDER_QUEUE_CAPACITY,
        };

        #[test]
        fn packetizer_passes_through_48khz_as_ten_millisecond_chunks() {
            let mut packetizer = NativeMicPacketizer::new(48_000, 480).unwrap();
            let samples: Vec<f32> = (0..NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK)
                .map(|sample| sample as f32)
                .collect();

            let chunks = packetizer.push_input(&samples).unwrap();

            assert_eq!(chunks, vec![samples]);
        }

        #[test]
        fn packetizer_buffers_partial_48khz_input() {
            let mut packetizer = NativeMicPacketizer::new(48_000, 480).unwrap();
            let first = vec![0.1; 240];
            let second = vec![0.2; 240];

            assert!(packetizer.push_input(&first).unwrap().is_empty());
            let chunks = packetizer.push_input(&second).unwrap();

            assert_eq!(chunks.len(), 1);
            assert_eq!(chunks[0].len(), NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK);
            assert!(chunks[0][..240].iter().all(|sample| *sample == 0.1));
            assert!(chunks[0][240..].iter().all(|sample| *sample == 0.2));
        }

        #[test]
        fn packetizer_emits_multiple_48khz_chunks_from_oversized_input() {
            let mut packetizer = NativeMicPacketizer::new(48_000, 480).unwrap();
            let samples = vec![0.3; NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK * 2];

            let chunks = packetizer.push_input(&samples).unwrap();

            assert_eq!(chunks.len(), 2);
            assert!(chunks
                .iter()
                .all(|chunk| chunk.len() == NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK));
        }

        #[test]
        fn packetizer_carries_remainder_across_chunk_boundaries() {
            let mut packetizer = NativeMicPacketizer::new(48_000, 480).unwrap();
            let mut first = vec![0.4; NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK];
            first.extend(vec![0.5; 100]);
            let second = vec![0.6; NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK - 100];

            let first_chunks = packetizer.push_input(&first).unwrap();
            let second_chunks = packetizer.push_input(&second).unwrap();

            assert_eq!(first_chunks.len(), 1);
            assert!(first_chunks[0].iter().all(|sample| *sample == 0.4));
            assert_eq!(second_chunks.len(), 1);
            assert!(second_chunks[0][..100].iter().all(|sample| *sample == 0.5));
            assert!(second_chunks[0][100..].iter().all(|sample| *sample == 0.6));
        }

        #[test]
        fn packetizer_resamples_44khz_input_to_48khz_chunks() {
            let mut packetizer = NativeMicPacketizer::new(44_100, 441).unwrap();
            let samples = vec![0.25; 441];

            let mut chunks = Vec::new();
            for _ in 0..8 {
                chunks.extend(packetizer.push_input(&samples).unwrap());
            }

            assert!(!chunks.is_empty());
            assert!(chunks
                .iter()
                .all(|chunk| chunk.len() == NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK));
            let mean_abs = chunks
                .iter()
                .flatten()
                .map(|sample| sample.abs())
                .sum::<f32>()
                / chunks.iter().map(Vec::len).sum::<usize>() as f32;
            assert!(
                (0.20..=0.30).contains(&mean_abs),
                "resampled constant signal should preserve amplitude, got {mean_abs}"
            );
        }

        #[test]
        fn software_aec_core_processes_ten_millisecond_frames() {
            let mut aec = SoftwareAecCore::new(30).unwrap();
            let render: Vec<f32> = (0..NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK)
                .map(|sample| (sample as f32 / 40.0).cos() * 0.25)
                .collect();
            let capture: Vec<f32> = render
                .iter()
                .enumerate()
                .map(|(sample, echo)| (sample as f32 / 20.0).sin() * 0.1 + echo * 0.4)
                .collect();

            let output = aec.process(&render, &capture).unwrap();

            assert_eq!(output.len(), NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK);
            assert!(output.iter().all(|sample| sample.is_finite()));
            assert!(rms(&output) < rms(&capture) * 0.99);
        }

        #[test]
        fn software_aec_core_sets_stream_delay_hint() {
            let aec = SoftwareAecCore::new(37).unwrap();

            assert_eq!(aec.stream_delay_ms(), 37);
        }

        #[test]
        fn software_aec_core_rejects_wrong_size_render_frame() {
            let mut aec = SoftwareAecCore::new(30).unwrap();
            let render = vec![0.0; NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK - 1];
            let capture = vec![0.0; NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK];

            let error = aec.process(&render, &capture).unwrap_err();

            assert!(error.contains("AEC render frame had 479 samples"));
        }

        #[test]
        fn software_aec_core_rejects_wrong_size_capture_frame() {
            let mut aec = SoftwareAecCore::new(30).unwrap();
            let render = vec![0.0; NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK];
            let capture = vec![0.0; NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK - 1];

            let error = aec.process(&render, &capture).unwrap_err();

            assert!(error.contains("AEC capture frame had 479 samples"));
        }

        #[test]
        fn software_aec_core_attenuates_aligned_echo_after_convergence() {
            let mut aec = SoftwareAecCore::new(0).unwrap();
            let render: Vec<f32> = (0..NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK)
                .map(|sample| {
                    ((sample as f32 / 13.0).sin() * 0.25) + ((sample as f32 / 29.0).cos() * 0.15)
                })
                .collect();
            let capture: Vec<f32> = render.iter().map(|sample| sample * 0.7).collect();
            let input_rms = rms(&capture);
            let mut output_rms = input_rms;

            for _ in 0..180 {
                let output = aec.process(&render, &capture).unwrap();
                output_rms = rms(&output);
            }

            assert!(
                output_rms < input_rms * 0.90,
                "software AEC should attenuate an aligned echo after convergence; input_rms={input_rms}, output_rms={output_rms}"
            );
        }

        #[test]
        fn software_aec_delay_estimate_uses_capture_render_and_processing_periods() {
            assert_eq!(estimate_software_aec_delay_ms(100_000, 200_000), 40);
        }

        #[test]
        fn software_aec_delay_estimate_clamps_to_sonora_limit() {
            assert_eq!(estimate_software_aec_delay_ms(9_000_000, 9_000_000), 500);
        }

        #[test]
        fn render_reference_queue_returns_silence_when_empty() {
            let mut queue = VecDeque::new();

            let samples = next_render_reference_frame(&mut queue);

            assert_eq!(samples.len(), NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK);
            assert!(samples.iter().all(|sample| *sample == 0.0));
        }

        #[test]
        fn render_reference_queue_preserves_oldest_frames_when_capacity_is_reached() {
            let mut queue = VecDeque::new();
            for frame in 0..(NATIVE_MIC_SOFTWARE_AEC_RENDER_QUEUE_CAPACITY + 2) {
                enqueue_render_reference_frame(
                    &mut queue,
                    vec![frame as f32; NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK],
                );
            }

            assert_eq!(queue.len(), NATIVE_MIC_SOFTWARE_AEC_RENDER_QUEUE_CAPACITY);
            for expected in 0..NATIVE_MIC_SOFTWARE_AEC_RENDER_QUEUE_CAPACITY {
                let samples = next_render_reference_frame(&mut queue);
                assert_eq!(samples[0], expected as f32);
            }
        }

        #[test]
        fn software_aec_error_path_passes_capture_samples_through() {
            let capture = vec![0.125; NATIVE_MIC_OUTPUT_FRAMES_PER_CHUNK];
            let mut warned = false;

            let output = handle_software_aec_error(&mut warned, "test failure", &capture);

            assert_eq!(output, capture);
            assert!(warned);
        }

        fn rms(samples: &[f32]) -> f32 {
            (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32)
                .sqrt()
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use tauri::ipc::{Channel, InvokeResponseBody};

    use super::super::audio_capture::NativeAudioCaptureHandle;

    pub fn start_native_mic_capture(
        _on_audio: Channel<InvokeResponseBody>,
    ) -> Result<NativeAudioCaptureHandle, String> {
        Err("Native microphone capture is only available on Windows".to_string())
    }
}

pub use platform::start_native_mic_capture;
