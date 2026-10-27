//! Requests to the server off the drawing thread. A few workers take requests
//! in turn, so a slow answer (the guide, a layout save) never holds up the
//! heartbeat; pictures go to one worker of their own at a lower priority, as
//! decoding them on every core at once took the CPU from the frames (recent
//! apps' snapshots dropped frames on a G3). Each reply wakes the event loop.

use crate::http;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

pub enum Job {
    Get(String),
    Post(String, serde_json::Value),
}

pub struct ImageJob {
    pub path: String,
    /// Shrunk to at most this many pixels on its longer side.
    pub max: u32,
    /// The hash of the bytes last decoded for this picture: the same again is
    /// answered as Unchanged without decoding.
    pub known: Option<u64>,
}

pub enum Reply {
    Json(Option<serde_json::Value>),
    Posted(Option<(u16, serde_json::Value)>),
    Image(Option<Decoded>),
    Unchanged,
}

pub struct Decoded {
    pub w: u32,
    pub h: u32,
    /// Premultiplied RGBA.
    pub px: Vec<u8>,
    pub hash: u64,
}

pub struct Api<T> {
    jobs: Sender<(T, Job)>,
    images: Sender<(T, ImageJob)>,
    pub replies: Receiver<(T, Reply)>,
}

fn nice() {
    extern "C" {
        fn setpriority(which: i32, who: u32, prio: i32) -> i32;
    }
    // PRIO_PROCESS with 0 is the calling thread on Linux.
    unsafe {
        setpriority(0, 0, 10);
    }
}

impl<T: Send + 'static> Api<T> {
    pub fn new(server: String, workers: usize, wake: u32) -> Api<T> {
        let (jtx, jrx) = channel::<(T, Job)>();
        let (itx, irx) = channel::<(T, ImageJob)>();
        let (rtx, rrx) = channel::<(T, Reply)>();
        let jrx = Arc::new(Mutex::new(jrx));
        for _ in 0..workers {
            let jrx = jrx.clone();
            let rtx = rtx.clone();
            let server = server.clone();
            std::thread::spawn(move || loop {
                let next = jrx.lock().unwrap().recv();
                let (tag, job) = match next {
                    Ok(j) => j,
                    Err(_) => return,
                };
                let reply = match job {
                    Job::Get(path) => Reply::Json(http::get_json(&server, &path).ok()),
                    Job::Post(path, body) => Reply::Posted(http::post_json(&server, &path, &body).ok()),
                };
                if rtx.send((tag, reply)).is_err() {
                    return;
                }
                crate::sdl::push_user(wake, 0);
            });
        }
        std::thread::spawn(move || {
            nice();
            while let Ok((tag, job)) = irx.recv() {
                let reply = match http::get_bytes(&server, &job.path) {
                    Err(_) => Reply::Image(None),
                    Ok(b) => {
                        let hash = fnv(&b);
                        if job.known == Some(hash) {
                            Reply::Unchanged
                        } else {
                            Reply::Image(decode(&b, job.max).map(|mut d| {
                                d.hash = hash;
                                d
                            }))
                        }
                    }
                };
                if rtx.send((tag, reply)).is_err() {
                    return;
                }
                crate::sdl::push_user(wake, 0);
            }
        });
        Api { jobs: jtx, images: itx, replies: rrx }
    }

    /// No workers: the requests made are read from the returned receivers
    /// and the replies given to the view by hand.
    #[cfg(test)]
    pub fn fake() -> (Api<T>, Receiver<(T, Job)>, Receiver<(T, ImageJob)>) {
        let (jtx, jrx) = channel();
        let (itx, irx) = channel();
        let (_rtx, rrx) = channel();
        (Api { jobs: jtx, images: itx, replies: rrx }, jrx, irx)
    }

    pub fn get(&self, tag: T, path: &str) {
        let _ = self.jobs.send((tag, Job::Get(path.to_string())));
    }
    pub fn post(&self, tag: T, path: &str, body: serde_json::Value) {
        let _ = self.jobs.send((tag, Job::Post(path.to_string(), body)));
    }
    pub fn image(&self, tag: T, path: &str, max: u32, known: Option<u64>) {
        let _ = self.images.send((tag, ImageJob { path: path.to_string(), max, known }));
    }
}

fn fnv(b: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for x in b {
        h ^= *x as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

pub fn decode(bytes: &[u8], max: u32) -> Option<Decoded> {
    let img = image::load_from_memory(bytes).ok()?;
    // thumbnail() averages whole pixels: a fraction of a filtered resize's
    // cost, and as good for shrinking.
    let img = if img.width() > max || img.height() > max { img.thumbnail(max, max) } else { img };
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    let mut px = rgba.into_raw();
    for p in px.chunks_exact_mut(4) {
        let a = p[3] as u32;
        if a < 255 {
            p[0] = ((p[0] as u32 * a + 127) / 255) as u8;
            p[1] = ((p[1] as u32 * a + 127) / 255) as u8;
            p[2] = ((p[2] as u32 * a + 127) / 255) as u8;
        }
    }
    Some(Decoded { w, h, px, hash: 0 })
}
