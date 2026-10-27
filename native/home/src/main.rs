//! Glasshouse Home drawn with OpenGL ES 2 in place of the web view: the same
//! home screen, without a browser engine between the remote and the panel.
//! sam starts it as LG's Home's app (lib/home-takeover.js stages it); on a
//! computer it runs in a window against a TV's server, for building and
//! checking it (`--server <tv>:8080`, with GLASSHOUSE_TOKEN).

mod anim;
mod api;
mod gfx;
mod http;
mod i18n;
mod model;
mod sdl;
mod text;
mod view;

use std::ffi::CString;
use std::io::Write;
use view::{Key, View};

fn log(msg: &str) {
    let line = format!("[{:.3}] {}\n", i18n::now_ms() / 1000.0, msg);
    eprint!("{}", line);
    // sam gives a native app's stdio to /dev/null.
    if cfg!(target_arch = "arm") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/glasshouse-home.log") {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

struct Options {
    server: String,
    assets: String,
    lang: String,
    window: bool,
    wall: Option<String>,
    hour: Option<i32>,
    script: Vec<String>,
    profile: bool,
    app_id: Option<String>,
    preload: bool,
}

fn options() -> Options {
    let args: Vec<String> = std::env::args().collect();
    // Beside the executable, written by the server when it stages the app.
    let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let staged: serde_json::Value = dir
        .as_ref()
        .and_then(|d| std::fs::read(d.join("glasshouse-home.json")).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(serde_json::Value::Null);
    let mut o = Options {
        server: std::env::var("GLASSHOUSE_SERVER").unwrap_or_else(|_| "127.0.0.1:8080".into()),
        assets: staged.get("assets").and_then(|v| v.as_str()).unwrap_or("/var/lib/tvweb/assets").to_string(),
        lang: staged.get("lang").and_then(|v| v.as_str()).unwrap_or("en").to_string(),
        window: !cfg!(target_arch = "arm"),
        wall: None,
        hour: None,
        script: Vec::new(),
        profile: false,
        app_id: None,
        preload: false,
    };
    let mut i = 1;
    while i < args.len() {
        let a = args[i].as_str();
        let next = args.get(i + 1).cloned().unwrap_or_default();
        match a {
            "--server" => {
                o.server = next;
                i += 1;
            }
            "--assets" => {
                o.assets = next;
                i += 1;
            }
            "--lang" => {
                o.lang = next;
                i += 1;
            }
            "--wall" => {
                o.wall = Some(next);
                i += 1;
            }
            "--hour" => {
                o.hour = next.parse().ok();
                i += 1;
            }
            "--script" => {
                o.script = next.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
                i += 1;
            }
            "--fullscreen" => o.window = false,
            "--profile" => o.profile = true,
            _ => {
                // sam's launch: a JSON object, which carries a preview's wall or hour.
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(a) {
                    if let Some(nid) = v.get("nid").and_then(|x| x.as_str()) {
                        o.app_id = Some(nid.to_string());
                    }
                    // The preload manager starts Home in the background at boot
                    // ("preload":"full" on a G5, webOS 10.3.1): it stays out of
                    // sight until Home is opened, which reaches it as a relaunch.
                    o.preload = v.get("preload").is_some();
                    let p = v.get("params").cloned().unwrap_or(v.clone());
                    if let Some(w) = p.get("wall").and_then(|x| x.as_str()).filter(|w| w.chars().all(|c| c.is_ascii_lowercase())) {
                        o.wall = Some(w.to_string());
                    }
                    if let Some(h) = p.get("hour").and_then(|x| x.as_str().map(String::from).or_else(|| x.as_i64().map(|n| n.to_string()))) {
                        o.hour = h.parse().ok();
                    }
                }
            }
        }
        i += 1;
    }
    o
}

/// The remote's keys as SDL reports them: standard scancodes for the arrows
/// and OK, and LG's own for Back and the coloured buttons.
fn key_of(scancode: i32) -> Option<Key> {
    match scancode {
        79 => Some(Key::Right),
        80 => Some(Key::Left),
        81 => Some(Key::Down),
        82 => Some(Key::Up),
        40 | 88 | 44 => Some(Key::Ok),
        // Escape and Backspace on a computer.
        41 | 42 => Some(Key::Back),
        21 => Some(Key::Red),
        28 => Some(Key::Yellow),
        _ => webos_key(scancode),
    }
}

#[cfg(target_arch = "arm")]
fn webos_key(scancode: i32) -> Option<Key> {
    match scancode {
        482 => Some(Key::Back),
        486 => Some(Key::Red),
        488 => Some(Key::Yellow),
        _ => None,
    }
}
#[cfg(not(target_arch = "arm"))]
fn webos_key(_: i32) -> Option<Key> {
    None
}

/// The keyboard event's state, repeat and scancode. LG's SDL (2.0.14 on
/// webOS 9) has four more bytes before them than SDL's own layout: its
/// state sits where SDL's scancode is, and is 0 or 1.
fn key_fields(e: &sdl::Event) -> (bool, i32) {
    let at = |o: usize| u32::from_ne_bytes([e.raw[o], e.raw[o + 1], e.raw[o + 2], e.raw[o + 3]]);
    if at(16) <= 1 {
        (e.raw[17] != 0, at(20) as i32)
    } else {
        (e.raw[13] != 0, at(16) as i32)
    }
}

fn screenshot(path: &str, w: i32, h: i32) {
    let mut px = vec![0u8; (w * h * 4) as usize];
    unsafe {
        gl::ReadPixels(0, 0, w, h, gl::RGBA, gl::UNSIGNED_BYTE, px.as_mut_ptr() as *mut _);
    }
    let mut flipped = vec![0u8; px.len()];
    let row = (w * 4) as usize;
    for y in 0..h as usize {
        flipped[y * row..(y + 1) * row].copy_from_slice(&px[(h as usize - 1 - y) * row..(h as usize - y) * row]);
    }
    match image::save_buffer(path, &flipped, w as u32, h as u32, image::ColorType::Rgba8) {
        Ok(_) => log(&format!("screenshot {}", path)),
        Err(e) => log(&format!("screenshot {}: {}", path, e)),
    }
}

fn main() {
    let t0 = i18n::now_ms();
    let o = options();
    log(&format!("start server={} assets={} args={:?}", o.server, o.assets, std::env::args().skip(1).collect::<Vec<_>>()));
    // LG's SDL names the surface for the compositor from APPID, which sam does
    // not set: without it nothing is in front as far as sam can tell.
    if let Some(id) = &o.app_id {
        std::env::set_var("APPID", id);
    }
    let wake_kind = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    sdl::relaunch_signal(wake_kind.clone());
    unsafe {
        // Back reaches the app rather than the system, which would send it away.
        sdl::hint("SDL_WEBOS_ACCESS_POLICY_KEYS_BACK", "true");
        sdl::hint("SDL_WEBOS_ACCESS_POLICY_KEYS_EXIT", "false");
        // SDL holds the system's screen saver off for any window by default;
        // Home is where the TV is left idle, so the screen saver must come.
        sdl::hint("SDL_VIDEO_ALLOW_SCREENSAVER", "1");
        if sdl::SDL_Init(sdl::SDL_INIT_VIDEO | sdl::SDL_INIT_EVENTS) != 0 {
            log(&format!("SDL_Init: {}", sdl::error()));
            std::process::exit(1);
        }
        if cfg!(target_arch = "arm") {
            sdl::SDL_GL_SetAttribute(sdl::SDL_GL_CONTEXT_PROFILE_MASK, sdl::SDL_GL_CONTEXT_PROFILE_ES);
            sdl::SDL_GL_SetAttribute(sdl::SDL_GL_CONTEXT_MAJOR_VERSION, 2);
            sdl::SDL_GL_SetAttribute(sdl::SDL_GL_CONTEXT_MINOR_VERSION, 0);
        } else {
            sdl::SDL_GL_SetAttribute(sdl::SDL_GL_CONTEXT_MAJOR_VERSION, 2);
            sdl::SDL_GL_SetAttribute(sdl::SDL_GL_CONTEXT_MINOR_VERSION, 1);
        }
        sdl::SDL_GL_SetAttribute(sdl::SDL_GL_DOUBLEBUFFER, 1);
        sdl::SDL_GL_SetAttribute(sdl::SDL_GL_DEPTH_SIZE, 0);
        sdl::SDL_GL_SetAttribute(sdl::SDL_GL_STENCIL_SIZE, 0);
        let title = CString::new("Glasshouse Home").unwrap();
        let flags = sdl::SDL_WINDOW_OPENGL
            | if o.window { sdl::SDL_WINDOW_ALLOW_HIGHDPI } else { sdl::SDL_WINDOW_FULLSCREEN }
            | if o.preload { sdl::SDL_WINDOW_HIDDEN } else { 0 };
        let (ww, wh) = if o.window { (1280, 720) } else { (1920, 1080) };
        let pos = if o.window { sdl::SDL_WINDOWPOS_CENTERED } else { 0 };
        let win = sdl::SDL_CreateWindow(title.as_ptr(), pos, pos, ww, wh, flags);
        if win.is_null() {
            log(&format!("SDL_CreateWindow: {}", sdl::error()));
            std::process::exit(1);
        }
        let ctx = sdl::SDL_GL_CreateContext(win);
        if ctx.is_null() {
            log(&format!("SDL_GL_CreateContext: {}", sdl::error()));
            std::process::exit(1);
        }
        sdl::SDL_GL_SetSwapInterval(1);
        gl::load_with(|s| sdl::proc_address(s));
        let mut g = match gfx::Gfx::new() {
            Ok(g) => g,
            Err(e) => {
                log(&format!("gfx: {}", e));
                std::process::exit(1);
            }
        };
        let mut tx = match text::Text::new(&o.assets) {
            Ok(t) => t,
            Err(e) => {
                log(&format!("text: {}", e));
                std::process::exit(1);
            }
        };
        let wake = sdl::SDL_RegisterEvents(1);
        wake_kind.store(wake, std::sync::atomic::Ordering::SeqCst);
        let api = api::Api::new(o.server.clone(), 4, wake);
        let mut v = View::new(api, i18n::I18n::load(&o.assets, &o.lang), o.wall.clone(), o.hour, t0);
        v.start();
        log(&format!("ready in {:.0} ms, video {}", i18n::now_ms() - t0, sdl::video_driver()));

        let mut e = sdl::Event::new();
        let mut first_frame = true;
        let mut script = o.script.clone().into_iter();
        let mut script_at = i18n::now_ms() + 1500.0;
        let mut last_frame = 0.0f64;
        let mut frames: Vec<f64> = Vec::new();
        let mut hidden = o.preload;
        v.visible = !o.preload;
        if o.preload {
            log("preloaded: hidden until Home is opened");
        }
        let mut dirty = true;
        let mut relaunch_at = 0.0f64;
        let mut warming = false;
        let mut warmed_at = 0.0f64;
        // Frame intervals while something moves, reported when it stops.
        let mut run: Vec<f64> = Vec::new();
        let mut run_cpu: Vec<f64> = Vec::new();
        let mut run_view: Vec<f64> = Vec::new();
        let mut was_animating = false;
        let mut pointer_visible = true;
        let mut pointer_position = None;
        let mut pointer_travel = 0.0f32;
        loop {
            let animating = v.animating();
            let mut wait = v.next_timer_ms();
            if v.drifting() {
                // The drift moves a fifth of a pixel a second: four frames a second is smooth.
                wait = wait.min((last_frame + 250.0 - i18n::now_ms()).max(0.0));
            }
            if !o.script.is_empty() {
                wait = wait.min((script_at - i18n::now_ms()).max(0.0));
            }
            if animating || dirty {
                wait = 0.0;
            }
            if warming {
                wait = wait.min(4.0);
            }
            if hidden {
                wait = v.next_timer_ms();
                if warming {
                    wait = wait.min(4.0);
                }
            }
            let mut got = if wait > 0.0 { sdl::SDL_WaitEventTimeout(&mut e, wait.min(1000.0) as i32) } else { sdl::SDL_PollEvent(&mut e) };
            while got != 0 {
                dirty = true;
                match e.kind() {
                    sdl::SDL_QUIT => {
                        log("quit");
                        std::process::exit(0);
                    }
                    sdl::SDL_KEYDOWN | sdl::SDL_KEYUP => {
                        let (repeat, sc) = key_fields(&e);
                        if let Some(visible) = sdl::cursor_key(sc) {
                            // These are compositor notifications, not requests
                            // to change its mode again.
                            if pointer_visible != visible {
                                log(if visible { "input: pointer" } else { "input: directional" });
                            }
                            pointer_visible = visible;
                            if visible {
                                pointer_position = None;
                            }
                            got = sdl::SDL_PollEvent(&mut e);
                            continue;
                        }
                        if e.kind() == sdl::SDL_KEYDOWN {
                            trace(&format!("K {:.1} {}", i18n::now_ms(), sc));
                        }
                        match key_of(sc) {
                            Some(k) if e.kind() == sdl::SDL_KEYDOWN => {
                                if matches!(k, Key::Up | Key::Down | Key::Left | Key::Right) && pointer_visible {
                                    pointer_visible = false;
                                    pointer_travel = 0.0;
                                    sdl::cursor_visible(false);
                                    log("input: directional");
                                }
                                v.key_down(k, repeat);
                            }
                            Some(k) => v.key_up(k),
                            None => {
                                if e.kind() == sdl::SDL_KEYDOWN {
                                    log(&format!("key {} not used", sc));
                                }
                            }
                        }
                    }
                    sdl::SDL_MOUSEMOTION => {
                        let (x, y) = e.mouse_xy();
                        let moved = e.mouse_moved() && pointer_position != Some((x, y));
                        let last = pointer_position.replace((x, y));
                        if moved {
                            // LG does not always send cursor-show again after
                            // an explicit hide. Genuine motion restores it;
                            // stationary events cannot steal directional focus,
                            // nor the hand's drift while the arrows are in use.
                            if !pointer_visible {
                                if let Some((lx, ly)) = last {
                                    let (ax, ay) = stage_point(win, lx, ly);
                                    let (bx, by) = stage_point(win, x, y);
                                    pointer_travel += ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
                                }
                                if pointer_travel < POINTER_WAKE {
                                    got = sdl::SDL_PollEvent(&mut e);
                                    continue;
                                }
                                pointer_visible = true;
                                sdl::cursor_visible(true);
                                log("input: pointer");
                            }
                            if pointer_visible {
                                let (sx, sy) = stage_point(win, x, y);
                                v.pointer(sx, sy);
                            }
                        } else if !pointer_visible && !cfg!(target_arch = "arm") {
                            sdl::SDL_ShowCursor(0);
                        }
                    }
                    sdl::SDL_MOUSEBUTTONUP => {
                        if e.mouse_button() == 1 && (pointer_visible || !cfg!(target_arch = "arm")) {
                            let (x, y) = e.mouse_xy();
                            let (sx, sy) = stage_point(win, x, y);
                            v.click(sx, sy);
                        }
                    }
                    sdl::SDL_WINDOWEVENT => {
                        let we = e.window_event();
                        match we {
                            sdl::SDL_WINDOWEVENT_HIDDEN | sdl::SDL_WINDOWEVENT_MINIMIZED => {
                                if !hidden {
                                    log("hidden");
                                }
                                hidden = true;
                                v.visible = false;
                            }
                            sdl::SDL_WINDOWEVENT_SHOWN | sdl::SDL_WINDOWEVENT_RESTORED | sdl::SDL_WINDOWEVENT_FOCUS_GAINED => {
                                if hidden {
                                    log("shown again");
                                    hidden = false;
                                    v.visible = true;
                                    v.returned(None, None);
                                }
                            }
                            _ => {}
                        }
                    }
                    k if k == wake && e.user_code() == 1 => {
                        // sam relaunched Home: the server passes it on (lib/home-lifecycle.js).
                        let (wall, hour) = launch_params();
                        log(&format!("relaunch wall={:?} hour={:?}", wall, hour));
                        relaunch_at = i18n::now_ms();
                        sdl::SDL_ShowWindow(win);
                        sdl::SDL_RestoreWindow(win);
                        sdl::SDL_RaiseWindow(win);
                        hidden = false;
                        v.visible = true;
                        v.returned(wall, hour);
                    }
                    k if k == wake => {}
                    _ => {}
                }
                got = sdl::SDL_PollEvent(&mut e);
            }
            let mut replies = 0;
            let t_replies = i18n::now_ms();
            while let Ok((tag, reply)) = v.api.replies.try_recv() {
                v.reply(tag, reply);
                dirty = true;
                replies += 1;
            }
            let t_replies = i18n::now_ms() - t_replies;
            v.tick();
            if v.restart_for_build {
                log("new server build: restarting");
                // The path sam started, which the server has replaced: /proc/self/exe
                // names the old file, deleted.
                let exe = std::env::args().next().unwrap_or_default();
                let mut args: Vec<String> = std::env::args().skip(1).collect();
                // A boot preload may already have been opened, or a foreground
                // launch may now be behind another app. Keep the current state.
                let launch = args.first().and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok());
                if let Some(serde_json::Value::Object(mut launch)) = launch {
                    if hidden {
                        launch.insert("preload".into(), serde_json::json!("full"));
                    } else {
                        launch.remove("preload");
                    }
                    args[0] = serde_json::Value::Object(launch).to_string();
                } else if hidden {
                    args.insert(0, serde_json::json!({ "preload": "full" }).to_string());
                }
                let err = std::os::unix::process::CommandExt::exec(std::process::Command::new(exe).args(args));
                log(&format!("restart failed: {}", err));
                v.restart_for_build = false;
            }
            if !o.script.is_empty() && i18n::now_ms() >= script_at {
                match script.next() {
                    Some(step) => {
                        script_at = i18n::now_ms() + 350.0;
                        run_step(&step, &mut v, win, &mut script_at, &mut frames);
                        dirty = true;
                    }
                    None => {
                        log("script done");
                        std::process::exit(0);
                    }
                }
            }
            let now = i18n::now_ms();
            let drift_due = v.drifting() && now - last_frame >= 250.0;
            let minute_due = (now / 60000.0).floor() != (last_frame / 60000.0).floor();
            if hidden && dirty && now - warmed_at > 1000.0 {
                // Out of sight (preloaded, or another app in front): what has
                // arrived is drawn offscreen, so the glyphs, icons and wallpaper are
                // ready for the frame that shows Home (661 ms otherwise on a G5).
                warmed_at = now;
                let fbo = Offscreen::new(1920, 1080);
                g.begin(1920, 1080);
                v.draw(&mut g, &mut tx);
                g.end();
                fbo.done();
                dirty = false;
            }
            if hidden || !(dirty || v.animating() || drift_due || minute_due) {
                // Idle: the glyphs a screen not yet seen will want, a few at a time.
                warming = tx.prewarm(8);
                continue;
            }
            let (mut dw, mut dh) = (0, 0);
            sdl::SDL_GL_GetDrawableSize(win, &mut dw, &mut dh);
            // begin()'s clear waits for a free buffer: vsync, not work, so it is not timed.
            g.begin(dw, dh);
            let t_draw = i18n::now_ms();
            v.draw(&mut g, &mut tx);
            let t_view = i18n::now_ms() - t_draw;
            g.end();
            let t_cpu = i18n::now_ms() - t_draw;
            if let Some(path) = SHOT.with(|s| s.borrow_mut().take()) {
                // The stage at its own size, whatever the window's.
                let fbo = Offscreen::new(1920, 1080);
                g.begin(1920, 1080);
                v.draw(&mut g, &mut tx);
                g.end();
                screenshot(&path, 1920, 1080);
                fbo.done();
                g.begin(dw, dh);
                v.draw(&mut g, &mut tx);
                g.end();
            }
            sdl::SDL_GL_SwapWindow(win);
            let after = i18n::now_ms();
            if o.profile {
                frames.push(after);
                if frames.len() % 120 == 0 {
                    log(&format!("frame cpu {:.1} ms, draws {}", t_cpu, g.draws));
                }
            }
            if first_frame {
                first_frame = false;
                log(&format!("first frame {:.0} ms after start", after - t0));
            }
            if relaunch_at > 0.0 {
                log(&format!("drawn {:.0} ms after the relaunch", after - relaunch_at));
                relaunch_at = 0.0;
            }
            let moving = v.animating();
            if was_animating {
                run.push(after - last_frame);
                run_cpu.push(t_cpu);
                run_view.push(t_view);
            }
            trace(&format!("F {:.1} {} work {:.1} replies {} in {:.1} swap {:.1}", after, if was_animating { "moving" } else { "start" }, t_cpu, replies, t_replies, after - t_draw - t_cpu));
            if !moving && was_animating && run.len() >= 5 {
                // The swap returns unevenly as the driver queues buffers, so dropped
                // frames are counted from the run's length against the panel's 60 Hz.
                let span: f64 = run.iter().sum();
                let dropped = ((span / (1000.0 / 60.0)).round() as i64 - run.len() as i64).max(0);
                let mut d = run.clone();
                d.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let mut c = run_cpu.clone();
                c.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let q = |v: &[f64], f: f64| v[((v.len() as f64 - 1.0) * f).round() as usize];
                let mut vv = run_view.clone();
                vv.sort_by(|a, b| a.partial_cmp(b).unwrap());
                log(&format!(
                    "motion: {} frames in {:.0} ms ({:.1} fps, {} dropped), interval p50 {:.1} p95 {:.1} max {:.1} ms; work p95 {:.1} ms (last: wall {:.1}, top {:.1}, rows {:.1}), with gl p95 {:.1} ms, {} draw calls",
                    d.len(),
                    span,
                    d.len() as f64 * 1000.0 / span,
                    dropped,
                    q(&d, 0.5),
                    q(&d, 0.95),
                    d[d.len() - 1],
                    q(&vv, 0.95),
                    v.parts[0],
                    v.parts[1],
                    v.parts[2],
                    q(&c, 0.95),
                    g.draws
                ));
            }
            if !moving {
                run.clear();
                run_cpu.clear();
                run_view.clear();
            }
            was_animating = moving;
            last_frame = after;
            dirty = false;
        }
    }
}

/// Stage pixels the pointer must travel after an arrow press before it comes back.
const POINTER_WAKE: f32 = 24.0;

struct Offscreen {
    fbo: u32,
    tex: u32,
}

impl Offscreen {
    fn new(w: i32, h: i32) -> Offscreen {
        unsafe {
            let (mut fbo, mut tex) = (0, 0);
            gl::GenTextures(1, &mut tex);
            gl::BindTexture(gl::TEXTURE_2D, tex);
            gl::TexImage2D(gl::TEXTURE_2D, 0, gl::RGBA as i32, w, h, 0, gl::RGBA, gl::UNSIGNED_BYTE, std::ptr::null());
            gl::GenFramebuffers(1, &mut fbo);
            gl::BindFramebuffer(gl::FRAMEBUFFER, fbo);
            gl::FramebufferTexture2D(gl::FRAMEBUFFER, gl::COLOR_ATTACHMENT0, gl::TEXTURE_2D, tex, 0);
            Offscreen { fbo, tex }
        }
    }
    fn done(self) {
        unsafe {
            gl::BindFramebuffer(gl::FRAMEBUFFER, 0);
            gl::DeleteFramebuffers(1, &self.fbo);
            gl::DeleteTextures(1, &self.tex);
        }
    }
}

/// Raw frame and key times for benchmarking, while /tmp/glasshouse-home.trace
/// exists (checked once a second).
fn trace(line: &str) {
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
    static ON: AtomicBool = AtomicBool::new(false);
    static CHECKED: AtomicI64 = AtomicI64::new(0);
    let sec = (i18n::now_ms() / 1000.0) as i64;
    if CHECKED.swap(sec, Ordering::Relaxed) != sec {
        ON.store(std::path::Path::new("/tmp/glasshouse-home.trace").exists(), Ordering::Relaxed);
    }
    if !ON.load(Ordering::Relaxed) {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open("/tmp/glasshouse-home.frames") {
        let _ = writeln!(f, "{}", line);
    }
}

/// The relaunch's wall or hour, for previewing a wallpaper slot.
fn launch_params() -> (Option<String>, Option<i32>) {
    let v: serde_json::Value = std::fs::read("/tmp/glasshouse-home-launch.json")
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(serde_json::Value::Null);
    let wall = v.get("wall").and_then(|x| x.as_str()).filter(|w| !w.is_empty() && w.chars().all(|c| c.is_ascii_lowercase())).map(String::from);
    let hour = v.get("hour").and_then(|x| x.as_str().map(String::from).or_else(|| x.as_i64().map(|n| n.to_string()))).and_then(|h| h.parse().ok());
    (wall, hour)
}

thread_local! {
    static SHOT: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

fn stage_point(win: *mut sdl::Window, x: i32, y: i32) -> (f32, f32) {
    let (mut w, mut h) = (0, 0);
    unsafe {
        sdl::SDL_GetWindowSize(win, &mut w, &mut h);
    }
    let s = (w as f32 / gfx::STAGE_W).min(h as f32 / gfx::STAGE_H);
    (x as f32 / s, y as f32 / s)
}

/// A step of a `--script`: a key (`right`, `ok`, `back`, `hold-ok`), `wait:ms`,
/// `shot:path`, `point:x:y`, `click:x:y`, `frames` (report frame times since
/// the last `frames`) or `quit`.
fn run_step(step: &str, v: &mut View, win: *mut sdl::Window, at: &mut f64, frames: &mut Vec<f64>) {
    let _ = win;
    let parts: Vec<&str> = step.split(':').collect();
    let key = |n: &str| match n {
        "left" => Some(Key::Left),
        "right" => Some(Key::Right),
        "up" => Some(Key::Up),
        "down" => Some(Key::Down),
        "ok" => Some(Key::Ok),
        "back" => Some(Key::Back),
        "red" => Some(Key::Red),
        "yellow" => Some(Key::Yellow),
        _ => None,
    };
    match parts[0] {
        "wait" => *at = i18n::now_ms() + parts.get(1).and_then(|x| x.parse::<f64>().ok()).unwrap_or(500.0),
        "shot" => SHOT.with(|s| *s.borrow_mut() = Some(parts[1..].join(":"))),
        "point" | "click" => {
            let x = parts.get(1).and_then(|x| x.parse().ok()).unwrap_or(0.0);
            let y = parts.get(2).and_then(|x| x.parse().ok()).unwrap_or(0.0);
            if parts[0] == "point" {
                v.pointer(x, y)
            } else {
                v.click(x, y)
            }
        }
        "hold-ok" => {
            v.key_down(Key::Ok, false);
            *at = i18n::now_ms() + 900.0;
        }
        "release" => v.key_up(Key::Ok),
        "frames" => {
            report_frames(frames);
            frames.clear();
        }
        "quit" => std::process::exit(0),
        n => {
            if let Some(k) = key(n) {
                v.key_down(k, false);
                v.key_up(k);
            } else {
                log(&format!("script: unknown step {}", n));
            }
        }
    }
}

fn report_frames(frames: &[f64]) {
    if frames.len() < 2 {
        return;
    }
    let mut d: Vec<f64> = frames.windows(2).map(|w| w[1] - w[0]).collect();
    d.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p = |q: f64| d[((d.len() as f64 - 1.0) * q).round() as usize];
    log(&format!("frames {} p50 {:.1} p95 {:.1} max {:.1} ms", d.len(), p(0.5), p(0.95), d[d.len() - 1]));
}
