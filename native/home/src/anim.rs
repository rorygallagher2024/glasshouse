//! Transitions with CSS's timing functions, so each moves as the web view's did.

#[derive(Clone, Copy, Debug)]
pub struct Ease(f32, f32, f32, f32);

pub const EASE: Ease = Ease(0.25, 0.1, 0.25, 1.0);
pub const EASE_IN_OUT: Ease = Ease(0.42, 0.0, 0.58, 1.0);
/// The view's own curve for moves: cubic-bezier(.2,.7,.2,1).
pub const GLIDE: Ease = Ease(0.2, 0.7, 0.2, 1.0);

impl Ease {
    fn bez(a: f32, b: f32, t: f32) -> f32 {
        // One axis of a cubic Bézier from (0,0) to (1,1).
        3.0 * a * t * (1.0 - t) * (1.0 - t) + 3.0 * b * t * t * (1.0 - t) + t * t * t
    }
    pub fn at(self, x: f32) -> f32 {
        if x <= 0.0 {
            return 0.0;
        }
        if x >= 1.0 {
            return 1.0;
        }
        // Solve x(t) = x by bisection: plenty for a frame's precision.
        let (mut lo, mut hi) = (0.0f32, 1.0f32);
        let mut t = x;
        for _ in 0..20 {
            let v = Ease::bez(self.0, self.2, t);
            if (v - x).abs() < 1e-4 {
                break;
            }
            if v < x {
                lo = t;
            } else {
                hi = t;
            }
            t = (lo + hi) / 2.0;
        }
        Ease::bez(self.1, self.3, t)
    }
}

/// A value that glides to its target over `dur` seconds from wherever it is.
#[derive(Clone, Copy, Debug)]
pub struct Tween {
    from: f32,
    to: f32,
    start: f64,
    dur: f32,
    ease: Ease,
}

impl Tween {
    pub fn new(v: f32) -> Tween {
        Tween { from: v, to: v, start: 0.0, dur: 0.0, ease: EASE }
    }
    pub fn value(&self, now: f64) -> f32 {
        if self.dur <= 0.0 {
            return self.to;
        }
        let p = ((now - self.start) as f32 / self.dur).clamp(0.0, 1.0);
        self.from + (self.to - self.from) * self.ease.at(p)
    }
    pub fn target(&self) -> f32 {
        self.to
    }
    pub fn set(&mut self, to: f32, now: f64, dur: f32, ease: Ease) {
        if (to - self.to).abs() < 1e-6 {
            return;
        }
        self.from = self.value(now);
        self.to = to;
        self.start = now;
        self.dur = dur;
        self.ease = ease;
    }
    pub fn jump(&mut self, to: f32) {
        self.from = to;
        self.to = to;
        self.dur = 0.0;
    }
    pub fn moving(&self, now: f64) -> bool {
        self.dur > 0.0 && now - self.start < self.dur as f64
    }
}
