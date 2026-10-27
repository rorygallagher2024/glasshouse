//! Text: the dashboards' fonts (Outfit, Manrope) rasterised into one alpha
//! atlas at the size drawn, with the TV's own fonts for scripts they lack.
//! CSS's text-shadow (0 1px 12px) is a blurred copy of each glyph, kept in the
//! atlas beside it, so a shadowed line costs a second quad per glyph rather
//! than a blur pass per frame.

use crate::gfx::{Gfx, Rgba};
use fontdue::{Font, FontSettings};
use std::collections::HashMap;
use std::rc::Rc;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Face {
    OutfitLight,
    Outfit,
    Manrope,
    ManropeSemi,
}

const ATLAS: u32 = 2048;
/// CSS blur radius 12px is a Gaussian of sigma 6.
const SHADOW_SIGMA: f32 = 6.0;
const SHADOW_PAD: i32 = 18;

#[derive(Clone, Copy)]
struct Slot {
    uv: [f32; 4],
    // Bitmap placement relative to the pen on the baseline.
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

#[derive(Clone, Copy)]
pub struct PlacedGlyph {
    font: u16,
    index: u16,
    x: f32,
}

pub struct Run {
    glyphs: Vec<PlacedGlyph>,
    pub width: f32,
    px: f32,
}

#[derive(Clone, Copy)]
pub struct LineMetrics {
    pub ascent: f32,
    pub descent: f32,
    pub gap: f32,
}

impl LineMetrics {
    /// CSS `line-height: normal`.
    pub fn normal(&self) -> f32 {
        self.ascent + self.descent + self.gap
    }
    /// The baseline's offset from the top of a line box `line` high: the
    /// leading split evenly above and below, as browsers do.
    pub fn baseline_in(&self, line: f32) -> f32 {
        (line - (self.ascent + self.descent)) / 2.0 + self.ascent
    }
}

pub struct Text {
    fonts: Vec<Font>,
    faces: HashMap<Face, u16>,
    fallback_paths: Vec<String>,
    fallbacks_loaded: bool,
    fallback_from: usize,
    atlas: gl::types::GLuint,
    pen_x: i32,
    pen_y: i32,
    shelf_h: i32,
    slots: HashMap<(u16, u16, u32, bool), Option<Slot>>,
    runs: HashMap<(String, Face, u32, u32), Rc<Run>>,
    fallback_for: HashMap<char, u16>,
    pub full: bool,
    warm: Vec<(Face, f32, bool, char)>,
}

/// Every face and size the view draws, with whether it is shadowed: their
/// letters are rasterised while the view is idle, so a panel's first opening
/// does not (60 ms for recent apps' on a G3).
const WARM: [(Face, f32, bool); 26] = [
    (Face::OutfitLight, 176.0, true),
    (Face::Manrope, 28.0, true),
    (Face::Outfit, 70.0, true),
    (Face::Outfit, 52.0, true),
    (Face::ManropeSemi, 21.0, false),
    (Face::Manrope, 18.0, true),
    (Face::Manrope, 19.0, false),
    (Face::Manrope, 19.0, true),
    (Face::Manrope, 20.0, false),
    (Face::Manrope, 20.0, true),
    (Face::ManropeSemi, 20.0, false),
    (Face::Manrope, 21.0, false),
    (Face::Manrope, 21.0, true),
    (Face::ManropeSemi, 21.0, true),
    (Face::ManropeSemi, 22.0, true),
    (Face::Manrope, 23.0, false),
    (Face::Manrope, 23.0, true),
    (Face::Manrope, 25.0, true),
    (Face::Manrope, 26.0, false),
    (Face::Manrope, 26.0, true),
    (Face::OutfitLight, 32.0, true),
    (Face::Outfit, 32.0, true),
    (Face::OutfitLight, 40.0, false),
    (Face::OutfitLight, 44.0, true),
    (Face::OutfitLight, 48.0, true),
    (Face::OutfitLight, 72.0, true),
];

fn load(path: &str) -> Option<Font> {
    let bytes = std::fs::read(path).ok()?;
    Font::from_bytes(bytes, FontSettings { scale: 40.0, ..FontSettings::default() }).ok()
}

impl Text {
    pub fn new(assets: &str) -> Result<Text, String> {
        let mut fonts = Vec::new();
        let mut faces = HashMap::new();
        for (face, file) in [
            (Face::OutfitLight, "Outfit-Light.ttf"),
            (Face::Outfit, "Outfit-Regular.ttf"),
            (Face::Manrope, "Manrope-Regular.ttf"),
            (Face::ManropeSemi, "Manrope-SemiBold.ttf"),
        ] {
            let path = format!("{}/fonts/{}", assets, file);
            let f = load(&path).ok_or_else(|| format!("cannot load {}", path))?;
            faces.insert(face, fonts.len() as u16);
            fonts.push(f);
        }
        let fallback_from = fonts.len();
        // LG's own UI fonts on the TV, in the order its Home falls back.
        let fallback_paths = [
            "/usr/share/fonts/LG_Smart_UI-Regular.ttf",
            "/usr/share/fonts/LG_Smart_UI_AR_HE_TH-Regular.ttf",
            "/usr/share/fonts/LG_Smart_UI_JP.ttf",
            "/usr/share/fonts/DroidSansFallback.ttf",
            "/usr/share/fonts/LG_Smart_UI_Devanagari.ttf",
            "/usr/share/fonts/LG_Smart_UI_Bengali.ttf",
            "/usr/share/fonts/NotoEmoji-Regular.ttf",
            "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let atlas = unsafe {
            let mut id = 0;
            gl::GenTextures(1, &mut id);
            gl::BindTexture(gl::TEXTURE_2D, id);
            gl::PixelStorei(gl::UNPACK_ALIGNMENT, 1);
            let zero = vec![0u8; (ATLAS * ATLAS) as usize];
            gl::TexImage2D(gl::TEXTURE_2D, 0, gl::ALPHA as i32, ATLAS as i32, ATLAS as i32, 0, gl::ALPHA, gl::UNSIGNED_BYTE, zero.as_ptr() as *const _);
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::LINEAR as i32);
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::LINEAR as i32);
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE as i32);
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE as i32);
            id
        };
        Ok(Text {
            fonts,
            faces,
            fallback_paths,
            fallbacks_loaded: false,
            fallback_from,
            atlas,
            pen_x: 1,
            pen_y: 1,
            shelf_h: 0,
            slots: HashMap::new(),
            runs: HashMap::new(),
            fallback_for: HashMap::new(),
            full: false,
            warm: WARM.iter().flat_map(|&(f, px, sh)| (' '..='~').map(move |c| (f, px, sh, c))).collect(),
        })
    }

    /// Empties the atlas once it is full, so text drawn after re-rasterises.
    pub fn reset_if_full(&mut self) {
        if !self.full {
            return;
        }
        self.slots.clear();
        self.pen_x = 1;
        self.pen_y = 1;
        self.shelf_h = 0;
        self.full = false;
    }

    pub fn metrics(&self, face: Face, px: f32) -> LineMetrics {
        let f = &self.fonts[self.faces[&face] as usize];
        let m = f.horizontal_line_metrics(px).unwrap();
        LineMetrics { ascent: m.ascent, descent: -m.descent, gap: m.line_gap }
    }

    fn font_for(&mut self, primary: u16, c: char) -> (u16, u16) {
        let idx = self.fonts[primary as usize].lookup_glyph_index(c);
        if idx != 0 || c.is_whitespace() || c.is_control() {
            return (primary, idx);
        }
        if let Some(&f) = self.fallback_for.get(&c) {
            return (f, self.fonts[f as usize].lookup_glyph_index(c));
        }
        if !self.fallbacks_loaded {
            self.fallbacks_loaded = true;
            for p in self.fallback_paths.clone() {
                if let Some(f) = load(&p) {
                    self.fonts.push(f);
                }
            }
        }
        for f in self.fallback_from..self.fonts.len() {
            let i = self.fonts[f].lookup_glyph_index(c);
            if i != 0 {
                self.fallback_for.insert(c, f as u16);
                return (f as u16, i);
            }
        }
        (primary, 0)
    }

    /// Lays a single line out, cached by its text and style.
    pub fn run(&mut self, s: &str, face: Face, px: f32, letter_spacing: f32) -> Rc<Run> {
        let key = (s.to_string(), face, px.to_bits(), letter_spacing.to_bits());
        if let Some(r) = self.runs.get(&key) {
            return r.clone();
        }
        if self.runs.len() > 4000 {
            self.runs.clear();
        }
        let primary = self.faces[&face];
        let mut glyphs = Vec::new();
        let mut x = 0.0f32;
        let mut prev: Option<(u16, u16)> = None;
        for c in s.chars() {
            let (f, idx) = self.font_for(primary, c);
            if let Some((pf, pi)) = prev {
                if pf == f {
                    if let Some(k) = self.fonts[f as usize].horizontal_kern_indexed(pi, idx, px) {
                        x += k;
                    }
                }
            }
            let adv = self.fonts[f as usize].metrics_indexed(idx, px).advance_width;
            glyphs.push(PlacedGlyph { font: f, index: idx, x });
            x += adv + letter_spacing;
            prev = Some((f, idx));
        }
        let run = Rc::new(Run { glyphs, width: x, px });
        self.runs.insert(key, run.clone());
        run
    }

    pub fn width(&mut self, s: &str, face: Face, px: f32, ls: f32) -> f32 {
        self.run(s, face, px, ls).width
    }

    /// The line cut to `max` wide with an ellipsis, as text-overflow does.
    pub fn ellipsize(&mut self, s: &str, face: Face, px: f32, ls: f32, max: f32) -> String {
        if self.width(s, face, px, ls) <= max {
            return s.to_string();
        }
        let chars: Vec<char> = s.chars().collect();
        let (mut lo, mut hi) = (0usize, chars.len());
        while lo < hi {
            let mid = (lo + hi + 1) / 2;
            let cand: String = chars[..mid].iter().collect::<String>() + "\u{2026}";
            if self.width(&cand, face, px, ls) <= max {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        chars[..lo].iter().collect::<String>() + "\u{2026}"
    }

    /// Lines of at most `max` wide, broken at spaces.
    pub fn wrap(&mut self, s: &str, face: Face, px: f32, ls: f32, max: f32) -> Vec<String> {
        let mut lines = Vec::new();
        let mut line = String::new();
        for word in s.split(' ') {
            let cand = if line.is_empty() { word.to_string() } else { format!("{} {}", line, word) };
            if !line.is_empty() && self.width(&cand, face, px, ls) > max {
                lines.push(std::mem::take(&mut line));
                line = word.to_string();
            } else {
                line = cand;
            }
        }
        if !line.is_empty() {
            lines.push(line);
        }
        lines
    }

    fn slot(&mut self, font: u16, index: u16, px: f32, shadow: bool) -> Option<Slot> {
        let key = (font, index, px.to_bits(), shadow);
        if let Some(s) = self.slots.get(&key) {
            return *s;
        }
        let (m, bitmap) = self.fonts[font as usize].rasterize_indexed(index, px);
        if m.width == 0 || m.height == 0 {
            self.slots.insert(key, None);
            return None;
        }
        let (w, h, data, x, y) = if shadow {
            let (bw, bh, b) = blur(&bitmap, m.width as i32, m.height as i32, SHADOW_PAD, SHADOW_SIGMA);
            (bw, bh, b, m.xmin as f32 - SHADOW_PAD as f32, -(m.ymin as f32 + m.height as f32) - SHADOW_PAD as f32)
        } else {
            (m.width as i32, m.height as i32, bitmap, m.xmin as f32, -(m.ymin as f32 + m.height as f32))
        };
        if self.pen_x + w + 1 > ATLAS as i32 {
            self.pen_x = 1;
            self.pen_y += self.shelf_h + 1;
            self.shelf_h = 0;
        }
        if self.pen_y + h + 1 > ATLAS as i32 {
            self.full = true;
            return None;
        }
        let (ax, ay) = (self.pen_x, self.pen_y);
        unsafe {
            gl::BindTexture(gl::TEXTURE_2D, self.atlas);
            gl::PixelStorei(gl::UNPACK_ALIGNMENT, 1);
            gl::TexSubImage2D(gl::TEXTURE_2D, 0, ax, ay, w, h, gl::ALPHA, gl::UNSIGNED_BYTE, data.as_ptr() as *const _);
        }
        self.pen_x += w + 1;
        self.shelf_h = self.shelf_h.max(h);
        let a = ATLAS as f32;
        let s = Slot { uv: [ax as f32 / a, ay as f32 / a, (ax + w) as f32 / a, (ay + h) as f32 / a], x, y, w: w as f32, h: h as f32 };
        self.slots.insert(key, Some(s));
        Some(s)
    }

    /// Rasterises up to `n` glyphs still to warm; true while any are left.
    pub fn prewarm(&mut self, n: usize) -> bool {
        for _ in 0..n {
            let (face, px, shadow, c) = match self.warm.pop() {
                Some(w) => w,
                None => return false,
            };
            let primary = self.faces[&face];
            let (f, idx) = self.font_for(primary, c);
            self.slot(f, idx, px, false);
            if shadow {
                self.slot(f, idx, px, true);
            }
        }
        !self.warm.is_empty()
    }

    /// Draws `run` with its baseline at (x, y).
    pub fn draw(&mut self, g: &mut Gfx, run: &Run, x: f32, y: f32, c: Rgba) {
        // Whole pixels: the atlas holds each glyph rasterised at one phase.
        let (bx, by) = (x.round(), y.round());
        for pg in &run.glyphs {
            if let Some(s) = self.slot(pg.font, pg.index, run.px, false) {
                let gx = (bx + pg.x).round() + s.x;
                g.glyph(self.atlas, crate::gfx::Rect::new(gx, by + s.y, s.w, s.h), s.uv, c);
            }
        }
    }

    /// CSS `text-shadow: 0 1px 12px c`.
    pub fn draw_shadow(&mut self, g: &mut Gfx, run: &Run, x: f32, y: f32, c: Rgba) {
        let (bx, by) = (x.round(), y.round() + 1.0);
        for pg in &run.glyphs {
            if let Some(s) = self.slot(pg.font, pg.index, run.px, true) {
                let gx = (bx + pg.x).round() + s.x;
                g.glyph(self.atlas, crate::gfx::Rect::new(gx, by + s.y, s.w, s.h), s.uv, c);
            }
        }
    }
}

/// A Gaussian blur of an alpha bitmap, grown by `pad` on each side: three
/// box blurs each way, whose cost does not grow with the radius (a 37-tap
/// kernel made the first frames of the clock and rows drop on a G3).
fn blur(src: &[u8], w: i32, h: i32, pad: i32, sigma: f32) -> (i32, i32, Vec<u8>) {
    let (bw, bh) = (w + 2 * pad, h + 2 * pad);
    let mut a = vec![0f32; (bw * bh) as usize];
    for y in 0..h {
        for x in 0..w {
            a[((y + pad) * bw + x + pad) as usize] = src[(y * w + x) as usize] as f32;
        }
    }
    let mut b = vec![0f32; a.len()];
    for r in box_radii(sigma) {
        box_pass(&a, &mut b, bw, bh, r, true);
        box_pass(&b, &mut a, bw, bh, r, false);
    }
    (bw, bh, a.iter().map(|v| v.round().clamp(0.0, 255.0) as u8).collect())
}

/// Radii of three boxes whose repeated average approximates a Gaussian of `sigma`.
fn box_radii(sigma: f32) -> [i32; 3] {
    let n = 3.0;
    let ideal = (12.0 * sigma * sigma / n + 1.0).sqrt();
    let mut wl = ideal.floor() as i32;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wu = wl + 2;
    let m = ((12.0 * sigma * sigma - n * (wl * wl) as f32 - 4.0 * n * wl as f32 - 3.0 * n) / (-4.0 * wl as f32 - 4.0)).round() as i32;
    let mut out = [0; 3];
    for (i, o) in out.iter_mut().enumerate() {
        *o = (if (i as i32) < m { wl } else { wu } - 1) / 2;
    }
    out
}

/// One running-sum box average of radius `r` along rows or columns.
fn box_pass(src: &[f32], dst: &mut [f32], w: i32, h: i32, r: i32, rows: bool) {
    let (len, lines) = if rows { (w, h) } else { (h, w) };
    let idx = |line: i32, i: i32| if rows { (line * w + i) as usize } else { (i * w + line) as usize };
    let scale = 1.0 / (2 * r + 1) as f32;
    for line in 0..lines {
        let mut acc = 0.0f32;
        for i in -r..=r {
            if i >= 0 && i < len {
                acc += src[idx(line, i)];
            }
        }
        for i in 0..len {
            dst[idx(line, i)] = acc * scale;
            let out = i - r;
            let inn = i + r + 1;
            if out >= 0 {
                acc -= src[idx(line, out)];
            }
            if inn < len {
                acc += src[idx(line, inn)];
            }
        }
    }
}
