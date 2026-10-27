fn main() {
    // SDL2 from the TV's own libraries (tools/tv-cc), or Homebrew's on a Mac.
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("apple") {
        println!("cargo:rustc-link-search=native=/opt/homebrew/lib");
    }
    println!("cargo:rustc-link-lib=dylib=SDL2");
}
