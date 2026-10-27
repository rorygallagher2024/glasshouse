//! The painter: every shape on the stage is a quad drawn by one shader, which
//! rounds its corners with a signed distance, strokes it, dashes the stroke,
//! or fills it from a texture, an alpha glyph atlas or a radial gradient.
//! Quads are batched until the texture or clip changes.

use gl::types::*;
use std::ffi::CString;

pub const STAGE_W: f32 = 1920.0;
pub const STAGE_H: f32 = 1080.0;

const MODE_SHAPE: f32 = 0.0;
const MODE_IMAGE: f32 = 1.0;
const MODE_GLYPH: f32 = 2.0;
const MODE_SCRIMMED: f32 = 3.0;

// pos 2, local 2, half 2, params 4 (radius, border, mode, dash), colour 4, uv 2
const FLOATS: usize = 16;
const MAX_QUADS: usize = 8192;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba(pub f32, pub f32, pub f32, pub f32);

impl Rgba {
    pub fn hex(v: u32) -> Rgba {
        Rgba(((v >> 16) & 255) as f32 / 255.0, ((v >> 8) & 255) as f32 / 255.0, (v & 255) as f32 / 255.0, 1.0)
    }
    pub fn a(self, a: f32) -> Rgba {
        Rgba(self.0, self.1, self.2, self.3 * a)
    }
    fn premul(self) -> [f32; 4] {
        [self.0 * self.3, self.1 * self.3, self.2 * self.3, self.3]
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }
    pub fn inset(self, d: f32) -> Rect {
        Rect::new(self.x + d, self.y + d, self.w - 2.0 * d, self.h - 2.0 * d)
    }
    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.w && y < self.y + self.h
    }
}

#[derive(Clone, Copy)]
pub struct Texture {
    pub id: GLuint,
    pub w: u32,
    pub h: u32,
}

/// A run of quads sharing a texture and clip, drawn once the frame is recorded.
struct Cmd {
    tex: GLuint,
    scissor: Option<[i32; 4]>,
    first: usize,
    quads: usize,
}

pub struct Gfx {
    prog: GLuint,
    vbo: GLuint,
    vbo_size: usize,
    ibo: GLuint,
    u_view: GLint,
    /// The whole frame's vertices: uploaded once, as writing a buffer the GPU
    /// is still drawing from stalls the Mali driver at every batch (each
    /// batch cost about a millisecond on a G3).
    verts: Vec<f32>,
    cmds: Vec<Cmd>,
    batch_start: usize,
    tex: GLuint,
    white: GLuint,
    scissor: Option<[i32; 4]>,
    drawable_h: i32,
    /// Drawable pixels per stage pixel.
    scale: f32,
    pub draws: u32,
}

const VS: &str = r#"
attribute vec2 a_pos;
attribute vec2 a_local;
attribute vec2 a_half;
attribute vec4 a_par;
attribute vec4 a_col;
attribute vec2 a_uv;
uniform vec2 u_view;
varying vec2 v_local;
varying vec2 v_half;
varying vec4 v_par;
varying vec4 v_col;
varying vec2 v_uv;
void main() {
  v_local = a_local; v_half = a_half; v_par = a_par; v_col = a_col; v_uv = a_uv;
  gl_Position = vec4(a_pos.x / u_view.x * 2.0 - 1.0, 1.0 - a_pos.y / u_view.y * 2.0, 0.0, 1.0);
}
"#;

const FS: &str = r#"
uniform sampler2D u_tex;
varying vec2 v_local;
varying vec2 v_half;
varying vec4 v_par;
varying vec4 v_col;
varying vec2 v_uv;
float rounded(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
// The view's scrim over the wallpaper, as the alpha of black at a stage point:
// a vertical and a horizontal gradient and an ellipse at the top right.
float stops5(float t, float p0, float a0, float p1, float a1, float p2, float a2, float p3, float a3, float p4, float a4) {
  if (t < p1) return mix(a0, a1, (t - p0) / (p1 - p0));
  if (t < p2) return mix(a1, a2, (t - p1) / (p2 - p1));
  if (t < p3) return mix(a2, a3, (t - p2) / (p3 - p2));
  return mix(a3, a4, clamp((t - p3) / (p4 - p3), 0.0, 1.0));
}
float scrimKeep(vec2 p) {
  vec2 u = p / vec2(1920.0, 1080.0);
  float down = stops5(u.y, 0.0, 0.5, 0.18, 0.0, 0.36, 0.45, 0.62, 0.82, 1.0, 0.92);
  float across = stops5(u.x, 0.0, 0.72, 0.38, 0.35, 0.70, 0.0, 0.85, 0.0, 1.0, 0.0);
  float corner = 0.55 * (1.0 - clamp(length((p - vec2(1766.4, 151.2)) / vec2(652.8, 324.0)), 0.0, 1.0));
  return (1.0 - down) * (1.0 - across) * (1.0 - corner);
}
void main() {
  float mode = v_par.z;
  if (mode > 2.5) {
    gl_FragColor = texture2D(u_tex, v_uv) * v_col * vec4(vec3(scrimKeep(v_local)), 1.0);
    return;
  }
  float d = rounded(v_local, v_half, v_par.x);
  float cov = clamp(0.5 - d, 0.0, 1.0);
  if (v_par.y > 0.0) {
    cov *= clamp(0.5 + d + v_par.y, 0.0, 1.0);
    if (v_par.w > 0.0) {
      vec2 a = abs(v_local);
      float along = (v_half.x - a.x < v_half.y - a.y) ? v_local.y : v_local.x;
      cov *= step(mod(along + 4096.0, v_par.w * 2.0), v_par.w);
    }
  }
  if (mode > 1.5) {
    gl_FragColor = v_col * (texture2D(u_tex, v_uv).a * cov);
  } else if (mode > 0.5) {
    gl_FragColor = texture2D(u_tex, v_uv) * v_col * cov;
  } else {
    gl_FragColor = v_col * cov;
  }
}
"#;

fn compile(kind: GLenum, src: &str) -> Result<GLuint, String> {
    unsafe {
        let s = gl::CreateShader(kind);
        // GLSL ES wants a precision; desktop GLSL 1.20 (the Mac preview) has none.
        let full = if kind == gl::FRAGMENT_SHADER {
            format!("#ifdef GL_ES\n#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n#endif\n{}", src)
        } else {
            format!("#ifdef GL_ES\nprecision highp float;\n#endif\n{}", src)
        };
        let c = CString::new(full).unwrap();
        gl::ShaderSource(s, 1, &c.as_ptr(), std::ptr::null());
        gl::CompileShader(s);
        let mut ok = 0;
        gl::GetShaderiv(s, gl::COMPILE_STATUS, &mut ok);
        if ok == 0 {
            let mut buf = vec![0u8; 2048];
            let mut len = 0;
            gl::GetShaderInfoLog(s, 2048, &mut len, buf.as_mut_ptr() as *mut _);
            return Err(String::from_utf8_lossy(&buf[..len as usize]).into_owned());
        }
        Ok(s)
    }
}

impl Gfx {
    pub fn new() -> Result<Gfx, String> {
        unsafe {
            let vs = compile(gl::VERTEX_SHADER, VS)?;
            let fs = compile(gl::FRAGMENT_SHADER, FS)?;
            let prog = gl::CreateProgram();
            gl::AttachShader(prog, vs);
            gl::AttachShader(prog, fs);
            for (i, n) in ["a_pos", "a_local", "a_half", "a_par", "a_col", "a_uv"].iter().enumerate() {
                let c = CString::new(*n).unwrap();
                gl::BindAttribLocation(prog, i as u32, c.as_ptr());
            }
            gl::LinkProgram(prog);
            let mut ok = 0;
            gl::GetProgramiv(prog, gl::LINK_STATUS, &mut ok);
            if ok == 0 {
                return Err("shader link failed".into());
            }
            gl::UseProgram(prog);
            let uv = CString::new("u_view").unwrap();
            let ut = CString::new("u_tex").unwrap();
            let u_view = gl::GetUniformLocation(prog, uv.as_ptr());
            gl::Uniform1i(gl::GetUniformLocation(prog, ut.as_ptr()), 0);

            let mut vbo = 0;
            gl::GenBuffers(1, &mut vbo);
            gl::BindBuffer(gl::ARRAY_BUFFER, vbo);
            gl::BufferData(gl::ARRAY_BUFFER, (MAX_QUADS * 4 * FLOATS * 4) as isize, std::ptr::null(), gl::STREAM_DRAW);
            let vbo_size = MAX_QUADS * 4 * FLOATS * 4;
            let mut idx: Vec<u16> = Vec::with_capacity(MAX_QUADS * 6);
            for q in 0..MAX_QUADS as u16 {
                let b = q * 4;
                idx.extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);
            }
            let mut ibo = 0;
            gl::GenBuffers(1, &mut ibo);
            gl::BindBuffer(gl::ELEMENT_ARRAY_BUFFER, ibo);
            gl::BufferData(gl::ELEMENT_ARRAY_BUFFER, (idx.len() * 2) as isize, idx.as_ptr() as *const _, gl::STATIC_DRAW);
            for i in 0..6 {
                gl::EnableVertexAttribArray(i);
            }
            let white = upload_rgba(1, 1, &[255, 255, 255, 255], false).id;
            gl::Enable(gl::BLEND);
            gl::BlendFunc(gl::ONE, gl::ONE_MINUS_SRC_ALPHA);
            gl::Disable(gl::DEPTH_TEST);
            gl::Disable(gl::CULL_FACE);
            Ok(Gfx {
                prog,
                vbo,
                vbo_size,
                ibo,
                u_view,
                verts: Vec::with_capacity(MAX_QUADS * 4 * FLOATS),
                cmds: Vec::new(),
                batch_start: 0,
                tex: white,
                white,
                scissor: None,
                drawable_h: 0,
                scale: 1.0,
                draws: 0,
            })
        }
    }

    /// Starts a frame on a drawable of `w`x`h` pixels, the stage scaled to fit.
    pub fn begin(&mut self, w: i32, h: i32) {
        self.scale = (w as f32 / STAGE_W).min(h as f32 / STAGE_H);
        self.drawable_h = h;
        self.draws = 0;
        unsafe {
            gl::Viewport(0, 0, w, h);
            gl::Disable(gl::SCISSOR_TEST);
            gl::ClearColor(0.0, 0.0, 0.0, 1.0);
            gl::Clear(gl::COLOR_BUFFER_BIT);
            gl::UseProgram(self.prog);
            gl::ActiveTexture(gl::TEXTURE0);
            gl::BindBuffer(gl::ARRAY_BUFFER, self.vbo);
            gl::BindBuffer(gl::ELEMENT_ARRAY_BUFFER, self.ibo);
            gl::Uniform2f(self.u_view, w as f32 / self.scale, h as f32 / self.scale);
        }
        self.scissor = None;
        self.verts.clear();
        self.cmds.clear();
        self.batch_start = 0;
    }

    /// Closes the batch being recorded.
    pub fn flush(&mut self) {
        let end = self.verts.len() / (4 * FLOATS);
        if end > self.batch_start {
            self.cmds.push(Cmd { tex: self.tex, scissor: self.scissor, first: self.batch_start, quads: end - self.batch_start });
        }
        self.batch_start = end;
    }

    /// Uploads the frame and draws it.
    pub fn end(&mut self) {
        self.flush();
        unsafe {
            let bytes = self.verts.len() * 4;
            if bytes > self.vbo_size {
                self.vbo_size = bytes.next_power_of_two();
            }
            // A new store each frame, so the driver need not wait for the last frame's.
            gl::BufferData(gl::ARRAY_BUFFER, self.vbo_size as isize, std::ptr::null(), gl::STREAM_DRAW);
            gl::BufferSubData(gl::ARRAY_BUFFER, 0, bytes as isize, self.verts.as_ptr() as *const _);
            let stride = (FLOATS * 4) as i32;
            let mut bound_tex = 0;
            let mut bound_scissor: Option<Option<[i32; 4]>> = None;
            for c in &self.cmds {
                if bound_scissor != Some(c.scissor) {
                    match c.scissor {
                        Some([x, y, w, h]) => {
                            gl::Enable(gl::SCISSOR_TEST);
                            gl::Scissor(x, y, w, h);
                        }
                        None => gl::Disable(gl::SCISSOR_TEST),
                    }
                    bound_scissor = Some(c.scissor);
                }
                if c.tex != bound_tex {
                    gl::BindTexture(gl::TEXTURE_2D, c.tex);
                    bound_tex = c.tex;
                }
                // GLES 2 has no base vertex, so each run points the attributes at its quads.
                let mut q = 0;
                while q < c.quads {
                    let n = (c.quads - q).min(MAX_QUADS);
                    let base = (c.first + q) * 4 * FLOATS * 4;
                    let mut off = 0;
                    for (i, size) in [2, 2, 2, 4, 4, 2].iter().enumerate() {
                        gl::VertexAttribPointer(i as u32, *size, gl::FLOAT, gl::FALSE, stride, (base + off * 4) as *const _);
                        off += *size as usize;
                    }
                    gl::DrawElements(gl::TRIANGLES, (n * 6) as i32, gl::UNSIGNED_SHORT, std::ptr::null());
                    self.draws += 1;
                    q += n;
                }
            }
        }
        self.verts.clear();
        self.cmds.clear();
        self.batch_start = 0;
    }

    /// Clips what follows to `r` in stage pixels, or nothing with None.
    pub fn clip(&mut self, r: Option<Rect>) {
        let drawable_h = self.drawable_h;
        let s = r.map(|r| {
            let x = (r.x * self.scale).floor() as i32;
            let y = (r.y * self.scale).floor() as i32;
            let w = ((r.x + r.w) * self.scale).ceil() as i32 - x;
            let h = ((r.y + r.h) * self.scale).ceil() as i32 - y;
            [x, drawable_h - y - h, w.max(0), h.max(0)]
        });
        if s == self.scissor {
            return;
        }
        self.flush();
        self.scissor = s;
    }

    fn use_tex(&mut self, t: GLuint) {
        if t != self.tex {
            self.flush();
            self.tex = t;
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn quad(&mut self, r: Rect, radius: f32, border: f32, mode: f32, dash: f32, c: [f32; 4], uv: [f32; 4], pad: f32) {
        // Grown by a pixel so the edge's anti-aliasing has room.
        let g = r.inset(-pad);
        let (cx, cy) = (r.x + r.w / 2.0, r.y + r.h / 2.0);
        let (hx, hy) = (r.w / 2.0, r.h / 2.0);
        let du = if r.w > 0.0 { (uv[2] - uv[0]) / r.w } else { 0.0 };
        let dv = if r.h > 0.0 { (uv[3] - uv[1]) / r.h } else { 0.0 };
        let corners = [(g.x, g.y), (g.x + g.w, g.y), (g.x + g.w, g.y + g.h), (g.x, g.y + g.h)];
        for (x, y) in corners {
            let u = uv[0] + (x - r.x) * du;
            let v = uv[1] + (y - r.y) * dv;
            self.verts.extend_from_slice(&[x, y, x - cx, y - cy, hx, hy, radius, border, mode, dash, c[0], c[1], c[2], c[3], u, v]);
        }
    }

    pub fn fill(&mut self, r: Rect, radius: f32, c: Rgba) {
        if c.3 <= 0.0 || r.w <= 0.0 || r.h <= 0.0 {
            return;
        }
        let w = self.white;
        self.use_tex(w);
        self.quad(r, radius, 0.0, MODE_SHAPE, 0.0, c.premul(), [0.0; 4], 1.0);
    }

    /// A border of `width` inside `r`, dashed every `dash` pixels where given.
    pub fn stroke(&mut self, r: Rect, radius: f32, width: f32, c: Rgba, dash: f32) {
        if c.3 <= 0.0 {
            return;
        }
        let w = self.white;
        self.use_tex(w);
        self.quad(r, radius, width, MODE_SHAPE, dash, c.premul(), [0.0; 4], 1.0);
    }

    /// A panel with a coloured left border, as CSS draws border-left on a
    /// rounded box: the edge takes the panel's rounded outer corners.
    pub fn edged(&mut self, r: Rect, radius: f32, edge: f32, panel: Rgba, accent: Rgba) {
        self.fill(r, radius, panel);
        let keep = self.scissor;
        self.flush();
        let s = self.scale;
        let dh = self.drawable_h;
        let x = (r.x * s).floor() as i32;
        let w = ((r.x + edge) * s).round() as i32 - x;
        let y = (r.y * s).floor() as i32;
        let h = ((r.y + r.h) * s).ceil() as i32 - y;
        self.scissor = Some([x, dh - y - h, w, h]);
        self.fill(r, radius, accent);
        self.flush();
        self.scissor = keep;
    }

    /// CSS's outline: `width` outside `r`, its corners following the radius.
    pub fn outline(&mut self, r: Rect, radius: f32, width: f32, offset: f32, c: Rgba) {
        let o = r.inset(-(width + offset));
        self.stroke(o, radius + width + offset, width, c, 0.0);
    }

    /// A vertical (`vertical`) or horizontal gradient through `stops`
    /// (position 0 to 1 along it, colour).
    pub fn gradient(&mut self, r: Rect, vertical: bool, stops: &[(f32, Rgba)]) {
        let w = self.white;
        self.use_tex(w);
        for pair in stops.windows(2) {
            let (p0, c0) = pair[0];
            let (p1, c1) = pair[1];
            if p1 <= p0 {
                continue;
            }
            let (a, b) = (c0.premul(), c1.premul());
            let seg = if vertical {
                Rect::new(r.x, r.y + r.h * p0, r.w, r.h * (p1 - p0))
            } else {
                Rect::new(r.x + r.w * p0, r.y, r.w * (p1 - p0), r.h)
            };
            let corners = [(seg.x, seg.y), (seg.x + seg.w, seg.y), (seg.x + seg.w, seg.y + seg.h), (seg.x, seg.y + seg.h)];
            for (i, (x, y)) in corners.iter().enumerate() {
                let c = if vertical { if i < 2 { a } else { b } } else if i == 0 || i == 3 { a } else { b };
                self.verts.extend_from_slice(&[*x, *y, 0.0, 0.0, 8000.0, 8000.0, 0.0, 0.0, MODE_SHAPE, 0.0, c[0], c[1], c[2], c[3], 0.0, 0.0]);
            }
        }
    }

    /// A texture drawn into `r` from its `uv` rectangle, corners rounded.
    pub fn image(&mut self, t: &Texture, r: Rect, uv: [f32; 4], radius: f32, opacity: f32) {
        if opacity <= 0.0 {
            return;
        }
        self.use_tex(t.id);
        self.quad(r, radius, 0.0, MODE_IMAGE, 0.0, [opacity, opacity, opacity, opacity], uv, if radius > 0.0 { 1.0 } else { 0.0 });
    }

    /// A wallpaper layer with the scrim applied in the same pass: one
    /// full-screen draw where the layer and three gradients over it took four.
    pub fn scrimmed(&mut self, t: &Texture, r: Rect, opacity: f32) {
        if opacity <= 0.0 {
            return;
        }
        self.use_tex(t.id);
        let o = opacity;
        let corners = [(r.x, r.y, 0.0, 0.0), (r.x + r.w, r.y, 1.0, 0.0), (r.x + r.w, r.y + r.h, 1.0, 1.0), (r.x, r.y + r.h, 0.0, 1.0)];
        for (x, y, u, v) in corners {
            self.verts.extend_from_slice(&[x, y, x, y, 1.0, 1.0, 0.0, 0.0, MODE_SCRIMMED, 0.0, o, o, o, o, u, v]);
        }
    }

    /// One glyph from the alpha atlas.
    pub fn glyph(&mut self, atlas: GLuint, r: Rect, uv: [f32; 4], c: Rgba) {
        self.use_tex(atlas);
        self.quad(r, 0.0, 0.0, MODE_GLYPH, 0.0, c.premul(), uv, 0.0);
    }
}

pub fn upload_rgba(w: u32, h: u32, px: &[u8], mipmap: bool) -> Texture {
    unsafe {
        let mut id = 0;
        gl::GenTextures(1, &mut id);
        gl::BindTexture(gl::TEXTURE_2D, id);
        gl::PixelStorei(gl::UNPACK_ALIGNMENT, 1);
        gl::TexImage2D(gl::TEXTURE_2D, 0, gl::RGBA as i32, w as i32, h as i32, 0, gl::RGBA, gl::UNSIGNED_BYTE, px.as_ptr() as *const _);
        let pot = w.is_power_of_two() && h.is_power_of_two();
        if mipmap && pot {
            gl::GenerateMipmap(gl::TEXTURE_2D);
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::LINEAR_MIPMAP_LINEAR as i32);
        } else {
            gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::LINEAR as i32);
        }
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::LINEAR as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE as i32);
        Texture { id, w, h }
    }
}

/// A texture to be filled a band at a time with `upload_rows`.
pub fn alloc_rgba(w: u32, h: u32) -> Texture {
    unsafe {
        let mut id = 0;
        gl::GenTextures(1, &mut id);
        gl::BindTexture(gl::TEXTURE_2D, id);
        gl::TexImage2D(gl::TEXTURE_2D, 0, gl::RGBA as i32, w as i32, h as i32, 0, gl::RGBA, gl::UNSIGNED_BYTE, std::ptr::null());
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::LINEAR as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::LINEAR as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S, gl::CLAMP_TO_EDGE as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T, gl::CLAMP_TO_EDGE as i32);
        Texture { id, w, h }
    }
}

/// Rows `y` to `y + rows` of `px` (the whole image, RGBA) into `t`.
pub fn upload_rows(t: &Texture, px: &[u8], y: u32, rows: u32) {
    let start = (y * t.w * 4) as usize;
    unsafe {
        gl::BindTexture(gl::TEXTURE_2D, t.id);
        gl::PixelStorei(gl::UNPACK_ALIGNMENT, 1);
        gl::TexSubImage2D(gl::TEXTURE_2D, 0, 0, y as i32, t.w as i32, rows as i32, gl::RGBA, gl::UNSIGNED_BYTE, px[start..].as_ptr() as *const _);
    }
}

pub fn delete(t: &Texture) {
    unsafe {
        gl::DeleteTextures(1, &t.id);
    }
}
