//! The few SDL2 calls the view needs. On the TV this links against the TV's
//! own SDL (LG's webOS build, 2.0.14 on webOS 9), which owns the Wayland
//! surface and its webOS shell properties; on a computer, against Homebrew's.

#![allow(non_upper_case_globals, dead_code)]

use std::ffi::{c_char, c_int, c_void, CStr, CString};

pub const SDL_INIT_VIDEO: u32 = 0x20;
pub const SDL_INIT_EVENTS: u32 = 0x4000;
pub const SDL_WINDOW_OPENGL: u32 = 0x2;
pub const SDL_WINDOW_FULLSCREEN: u32 = 0x1;
pub const SDL_WINDOW_HIDDEN: u32 = 0x8;
pub const SDL_WINDOW_FULLSCREEN_DESKTOP: u32 = 0x1001;
pub const SDL_WINDOW_ALLOW_HIGHDPI: u32 = 0x2000;
pub const SDL_WINDOWPOS_CENTERED: c_int = 0x2FFF0000;

pub const SDL_QUIT: u32 = 0x100;
pub const SDL_WINDOWEVENT: u32 = 0x200;
pub const SDL_KEYDOWN: u32 = 0x300;
pub const SDL_KEYUP: u32 = 0x301;
pub const SDL_MOUSEMOTION: u32 = 0x400;
pub const SDL_MOUSEBUTTONDOWN: u32 = 0x401;
pub const SDL_MOUSEBUTTONUP: u32 = 0x402;
pub const SDL_MOUSEWHEEL: u32 = 0x403;
pub const SDL_USEREVENT: u32 = 0x8000;

pub const SDL_WINDOWEVENT_SHOWN: u8 = 1;
pub const SDL_WINDOWEVENT_HIDDEN: u8 = 2;
pub const SDL_WINDOWEVENT_EXPOSED: u8 = 3;
pub const SDL_WINDOWEVENT_RESIZED: u8 = 5;
pub const SDL_WINDOWEVENT_SIZE_CHANGED: u8 = 6;
pub const SDL_WINDOWEVENT_MINIMIZED: u8 = 7;
pub const SDL_WINDOWEVENT_RESTORED: u8 = 9;
pub const SDL_WINDOWEVENT_FOCUS_GAINED: u8 = 12;
pub const SDL_WINDOWEVENT_FOCUS_LOST: u8 = 13;

pub const SDL_GL_RED_SIZE: c_int = 0;
pub const SDL_GL_GREEN_SIZE: c_int = 1;
pub const SDL_GL_BLUE_SIZE: c_int = 2;
pub const SDL_GL_ALPHA_SIZE: c_int = 3;
pub const SDL_GL_DOUBLEBUFFER: c_int = 5;
pub const SDL_GL_DEPTH_SIZE: c_int = 6;
pub const SDL_GL_STENCIL_SIZE: c_int = 7;
pub const SDL_GL_MULTISAMPLEBUFFERS: c_int = 13;
pub const SDL_GL_MULTISAMPLESAMPLES: c_int = 14;
pub const SDL_GL_CONTEXT_MAJOR_VERSION: c_int = 17;
pub const SDL_GL_CONTEXT_MINOR_VERSION: c_int = 18;
pub const SDL_GL_CONTEXT_PROFILE_MASK: c_int = 21;
pub const SDL_GL_CONTEXT_PROFILE_CORE: c_int = 1;
pub const SDL_GL_CONTEXT_PROFILE_ES: c_int = 4;

#[repr(C)]
pub struct Event {
    pub raw: [u8; 56],
}

impl Event {
    pub fn new() -> Event {
        Event { raw: [0; 56] }
    }
    fn u32_at(&self, o: usize) -> u32 {
        u32::from_ne_bytes([self.raw[o], self.raw[o + 1], self.raw[o + 2], self.raw[o + 3]])
    }
    fn i32_at(&self, o: usize) -> i32 {
        self.u32_at(o) as i32
    }
    pub fn kind(&self) -> u32 {
        self.u32_at(0)
    }
    // SDL_KeyboardEvent: type, timestamp, windowID, state, repeat, 2 pad, keysym.
    pub fn key_repeat(&self) -> bool {
        self.raw[13] != 0
    }
    pub fn scancode(&self) -> i32 {
        self.i32_at(16)
    }
    pub fn keycode(&self) -> i32 {
        self.i32_at(20)
    }
    // SDL_WindowEvent: type, timestamp, windowID, event, 3 pad, data1, data2.
    pub fn window_event(&self) -> u8 {
        self.raw[12]
    }
    pub fn window_data(&self) -> (i32, i32) {
        (self.i32_at(16), self.i32_at(20))
    }
    // SDL_MouseMotionEvent and SDL_MouseButtonEvent both keep x and y at 20 and 24.
    pub fn mouse_xy(&self) -> (i32, i32) {
        (self.i32_at(20), self.i32_at(24))
    }
    pub fn mouse_button(&self) -> u8 {
        self.raw[16]
    }
    pub fn mouse_moved(&self) -> bool {
        self.i32_at(28) != 0 || self.i32_at(32) != 0
    }
    // SDL_UserEvent: type, timestamp, windowID, code.
    pub fn user_code(&self) -> i32 {
        self.i32_at(12)
    }
}

#[repr(C)]
pub struct Window {
    _p: [u8; 0],
}

extern "C" {
    pub fn SDL_Init(flags: u32) -> c_int;
    pub fn SDL_Quit();
    pub fn SDL_GetError() -> *const c_char;
    pub fn SDL_SetHint(name: *const c_char, value: *const c_char) -> c_int;
    pub fn SDL_CreateWindow(title: *const c_char, x: c_int, y: c_int, w: c_int, h: c_int, flags: u32) -> *mut Window;
    pub fn SDL_ShowWindow(w: *mut Window);
    pub fn SDL_RaiseWindow(w: *mut Window);
    pub fn SDL_RestoreWindow(w: *mut Window);
    pub fn SDL_GetWindowSize(w: *mut Window, x: *mut c_int, y: *mut c_int);
    pub fn SDL_GL_SetAttribute(attr: c_int, value: c_int) -> c_int;
    pub fn SDL_GL_GetAttribute(attr: c_int, value: *mut c_int) -> c_int;
    pub fn SDL_GL_CreateContext(w: *mut Window) -> *mut c_void;
    pub fn SDL_GL_MakeCurrent(w: *mut Window, c: *mut c_void) -> c_int;
    pub fn SDL_GL_GetProcAddress(name: *const c_char) -> *const c_void;
    pub fn SDL_GL_SetSwapInterval(i: c_int) -> c_int;
    pub fn SDL_GL_SwapWindow(w: *mut Window);
    pub fn SDL_GL_GetDrawableSize(w: *mut Window, x: *mut c_int, y: *mut c_int);
    pub fn SDL_PollEvent(e: *mut Event) -> c_int;
    pub fn SDL_WaitEventTimeout(e: *mut Event, ms: c_int) -> c_int;
    pub fn SDL_PushEvent(e: *mut Event) -> c_int;
    pub fn SDL_RegisterEvents(n: c_int) -> u32;
    pub fn SDL_GetTicks() -> u32;
    pub fn SDL_ShowCursor(toggle: c_int) -> c_int;
    pub fn SDL_GetCurrentVideoDriver() -> *const c_char;
    #[cfg(target_arch = "arm")]
    pub fn SDL_webOSCursorVisibility(visible: c_int) -> c_int;
}

pub fn cursor_visible(visible: bool) {
    unsafe {
        // LG's compositor owns the Magic Remote's pointer mode separately
        // from SDL's cursor image. Removing that image with SDL_ShowCursor(0)
        // prevents a shake from bringing it back on the G3 (webOS 9.2.2).
        #[cfg(target_arch = "arm")]
        SDL_webOSCursorVisibility(visible as c_int);
        #[cfg(not(target_arch = "arm"))]
        SDL_ShowCursor(visible as c_int);
    }
}

pub fn cursor_key(scancode: i32) -> Option<bool> {
    #[cfg(target_arch = "arm")]
    match scancode {
        484 => return Some(true),
        485 => return Some(false),
        _ => {}
    }
    let _ = scancode;
    None
}

pub fn error() -> String {
    unsafe { CStr::from_ptr(SDL_GetError()).to_string_lossy().into_owned() }
}

pub fn hint(name: &str, value: &str) {
    let n = CString::new(name).unwrap();
    let v = CString::new(value).unwrap();
    unsafe {
        SDL_SetHint(n.as_ptr(), v.as_ptr());
    }
}

pub fn proc_address(name: &str) -> *const c_void {
    let n = CString::new(name).unwrap();
    unsafe { SDL_GL_GetProcAddress(n.as_ptr()) }
}

pub fn video_driver() -> String {
    unsafe {
        let p = SDL_GetCurrentVideoDriver();
        if p.is_null() {
            String::new()
        } else {
            CStr::from_ptr(p).to_string_lossy().into_owned()
        }
    }
}

/// SIGUSR1 from the server: sam has relaunched Home (lib/home-lifecycle.js).
/// The signal is blocked in every thread and taken by one that waits for it,
/// which wakes the event loop with `code` 1; called before any other thread
/// starts, so all of them inherit the mask.
pub fn relaunch_signal(kind: std::sync::Arc<std::sync::atomic::AtomicU32>) {
    #[cfg(target_os = "linux")]
    const SIGUSR1: c_int = 10;
    #[cfg(not(target_os = "linux"))]
    const SIGUSR1: c_int = 30;
    #[cfg(target_os = "linux")]
    const SIG_BLOCK: c_int = 0;
    #[cfg(not(target_os = "linux"))]
    const SIG_BLOCK: c_int = 1;
    extern "C" {
        fn sigemptyset(set: *mut [u64; 16]) -> c_int;
        fn sigaddset(set: *mut [u64; 16], sig: c_int) -> c_int;
        fn pthread_sigmask(how: c_int, set: *const [u64; 16], old: *mut [u64; 16]) -> c_int;
        fn sigwait(set: *const [u64; 16], sig: *mut c_int) -> c_int;
    }
    let mut set = [0u64; 16];
    unsafe {
        sigemptyset(&mut set);
        sigaddset(&mut set, SIGUSR1);
        pthread_sigmask(SIG_BLOCK, &set, std::ptr::null_mut());
    }
    std::thread::spawn(move || loop {
        let mut sig: c_int = 0;
        if unsafe { sigwait(&set, &mut sig) } == 0 {
            let k = kind.load(std::sync::atomic::Ordering::SeqCst);
            if k != 0 {
                push_user(k, 1);
            }
        }
    });
}

/// Wakes the event loop from another thread: a reply has arrived.
pub fn push_user(kind: u32, code: i32) {
    let mut e = Event::new();
    e.raw[0..4].copy_from_slice(&kind.to_ne_bytes());
    e.raw[12..16].copy_from_slice(&code.to_ne_bytes());
    unsafe {
        SDL_PushEvent(&mut e);
    }
}
