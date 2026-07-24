fn main() {
    println!("cargo:rerun-if-env-changed=EASYCRIS_BUILD_PROFILE");
    println!("cargo:rerun-if-env-changed=EASYCRIS_DISABLE_SINGLE_INSTANCE");
    println!("cargo:rerun-if-env-changed=PROFILE");

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
    let disable_single_instance =
        std::env::var("EASYCRIS_DISABLE_SINGLE_INSTANCE").unwrap_or_else(|_| "0".to_string());
    println!("cargo:rustc-env=EASYCRIS_DISABLE_SINGLE_INSTANCE={disable_single_instance}");

    tauri_build::build()
}
