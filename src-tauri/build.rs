fn main() {
    println!("cargo:rerun-if-env-changed=EASYCRIS_BUILD_PROFILE");
    println!("cargo:rerun-if-env-changed=PROFILE");
    println!("cargo:rerun-if-env-changed=EASYCRIS_LITCRYPT_KEY");
    println!("cargo:rerun-if-env-changed=LITCRYPT_ENCRYPT_KEY");

    // Bake the build profile into the binary so runtime backend selection
    // can enforce hardened-release behavior without relying on external env vars.
    let build_profile = std::env::var("EASYCRIS_BUILD_PROFILE").unwrap_or_else(|_| {
        let cargo_profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
        if cargo_profile.eq_ignore_ascii_case("release") {
            "release".to_string()
        } else {
            "dev".to_string()
        }
    });
    println!("cargo:rustc-env=EASYCRIS_BUILD_PROFILE={build_profile}");

    // Obfuscation key is required only when the optional obfuscate feature is enabled.
    if std::env::var_os("CARGO_FEATURE_OBFUSCATE").is_some() {
        let easycris_key = std::env::var_os("EASYCRIS_LITCRYPT_KEY");
        let litcrypt_key = std::env::var_os("LITCRYPT_ENCRYPT_KEY");

        if litcrypt_key.is_none() {
            panic!(
                "LITCRYPT_ENCRYPT_KEY must be set when building with feature 'obfuscate' \
                 (release wrapper maps EASYCRIS_LITCRYPT_KEY -> LITCRYPT_ENCRYPT_KEY)"
            );
        }

        if let (Some(a), Some(b)) = (easycris_key, litcrypt_key) {
            if a != b {
                panic!(
                    "EASYCRIS_LITCRYPT_KEY and LITCRYPT_ENCRYPT_KEY are both set but differ; \
                     use a single matching value"
                );
            }
        }
    }

    tauri_build::build()
}
