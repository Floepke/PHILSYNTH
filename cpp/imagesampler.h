// Native twin of imagesampler.dsp.js. Images are immutable and shared; scanners, tables and
// voices belong to each instance. All render-time storage is allocated at construction, except a
// voice's own Propellor tables (a note with a phase other than 0), made the first time it needs
// them and kept until the instance is destroyed.
#pragma once
#include "osc.h"

namespace ms {

struct ImagePyramid {
  struct Level { int w, h; float* c; };
  Level levels[32];
  int count = 0;
  float* pixels = nullptr;

  ImagePyramid(int w, int h, const uint8_t* rgb) {
    size_t size = 0;
    for (int a = w, b = h;; a = (a + 1) / 2, b = (b + 1) / 2) {
      levels[count++] = {a, b, nullptr};
      size += (size_t)a * b * 3;
      if (a == 1 && b == 1) break;
    }
    pixels = (float*)malloc(size * sizeof(float));
    if (!pixels) return;
    size_t off = 0;
    for (int l = 0; l < count; l++) {
      Level& dst = levels[l];
      dst.c = pixels + off;
      off += (size_t)dst.w * dst.h * 3;
      if (!l) {
        for (int i = 0; i < w * h * 3; i++) dst.c[i] = (float)(rgb[i] / 127.5 - 1);
        continue;
      }
      const Level& src = levels[l - 1];
      for (int y = 0; y < dst.h; y++) for (int x = 0; x < dst.w; x++) {
        double sum[3] = {};
        int n = 0;
        for (int j = 2 * y; j < src.h && j < 2 * y + 2; j++) {
          for (int i = 2 * x; i < src.w && i < 2 * x + 2; i++) {
            for (int c = 0; c < 3; c++) sum[c] += src.c[(j * src.w + i) * 3 + c];
            n++;
          }
        }
        for (int c = 0; c < 3; c++) dst.c[(y * dst.w + x) * 3 + c] = (float)(sum[c] / n);
      }
    }
  }
  ~ImagePyramid() { free(pixels); }
};

struct ImageSampler : Osc {
  enum { POLY, SCAN_TYPE, X, Y, LENGTH, ROTATION, SPEED, OVAL_WIDTH, OVAL_HEIGHT, OVAL_ROTATION,
         RESOLUTION, RED_LEFT, GREEN_LEFT, BLUE_LEFT, RED_RIGHT, GREEN_RIGHT, BLUE_RIGHT,
         IMG_ATTACK, IMG_DECAY, IMG_SUSTAIN, IMG_RELEASE, IMG_ATK_CURVE, IMG_DEC_CURVE, IMG_REL_CURVE, IMG_GAIN,
         TRI_X1, TRI_Y1, TRI_X2, TRI_Y2, TRI_X3, TRI_Y3, PARAMS };
  enum { LINE, PROPELLOR, OVAL, TRIANGLE, RECTANGLE };
  static constexpr int RES_MAX = 1024, MAX_LEVELS = 16;
  struct Table {
    float buf[(2 * RES_MAX + 2 * MAX_LEVELS) * 3] = {};
    int off[MAX_LEVELS] = {}, len[MAX_LEVELS] = {}, count = 0;
  };
  double q[PARAMS] = {8, 0, 50, 50, 100, 0, 0.5, 60, 60, 0, 64,
    100, 50, 0, 0, 50, 100, 0.005, 0.2, 1, 0.3, 0, 0, 0, 0.5, 50, 15, 15, 85, 85, 85};
  ImagePyramid* image = nullptr;
  Table tables[2];
  int current = 0, revision = 0;
  double key[15] = {}, g[11] = {}, angle = 0, weights[6] = {};
  // closed polygon of the Triangle / Rectangle (corners, cumulative edge lengths)
  double px[5] = {}, py[5] = {}, cum[6] = {};
  int corners = 0;
  bool built = false, wasActive = false, haveG = false, haveWeights = false;
  // per voice: the Propellor's turn from the note's phase (degrees) and its own tables (2, or null)
  struct Own { Table tables[2]; int current; double key[15]; bool built; };
  double spin[MAX_VOICES] = {};
  bool fresh[MAX_VOICES] = {}; // nothing played yet: its first table needs no crossfade
  Own* own[MAX_VOICES] = {};

  explicit ImageSampler(double sr) : Osc(sr, 1) {}
  ~ImageSampler() override { for (auto* o : own) free(o); }

  void note(int type, double id, double pitch, double vel, double phase) override {
    Osc::note(type, id, pitch, vel, phase);
    if (type != NOTE_ON) return;
    Voice* v = voiceOf(id);
    if (!v) return;
    const int i = (int)(v - voices);
    spin[i] = v->phase * 360;
    fresh[i] = true;
    if (own[i]) own[i]->built = false;
  }
  void setImage(ImagePyramid* value) { image = value; revision++; }

  void param(int id, double value) override {
    if (id < 0 || id >= PARAMS) return;
    q[id] = value;
    switch (id) {
      case POLY: Osc::param(Osc::POLYPHONY, value); break;
      case IMG_ATTACK: p[ATTACK] = value; break;
      case IMG_DECAY: p[DECAY] = value; break;
      case IMG_SUSTAIN: p[SUSTAIN] = value; break;
      case IMG_RELEASE: p[RELEASE] = value; break;
    }
  }

  static double wrap(double d) {
    double r = fmod(d + 180, 360);
    return fmod(r + 360, 360) - 180;
  }
  static double percent(double v) { return clampd(v == v ? v : 0, 0, 100) / 100; }
  static double glide(double a, double b, double k) { return fabs(b - a) < 1e-6 ? b : a + (b - a) * k; }

  void read(int l, double px, double py, double* out) const {
    const auto& a = image->levels[l];
    const double s = 1.0 / (1 << l);
    const double x = clampd((px + 0.5) * s - 0.5, 0, a.w - 1);
    const double y = clampd((py + 0.5) * s - 0.5, 0, a.h - 1);
    const int x0 = (int)x, y0 = (int)y;
    const int x1 = x0 + 1 < a.w ? x0 + 1 : a.w - 1;
    const int y1 = y0 + 1 < a.h ? y0 + 1 : a.h - 1;
    const double fx = x - x0, fy = y - y0;
    for (int c = 0; c < 3; c++) {
      const double v00 = a.c[(y0 * a.w + x0) * 3 + c], v01 = a.c[(y0 * a.w + x1) * 3 + c];
      const double v10 = a.c[(y1 * a.w + x0) * 3 + c], v11 = a.c[(y1 * a.w + x1) * 3 + c];
      const double t0 = v00 + (v01 - v00) * fx, t1 = v10 + (v11 - v10) * fx;
      out[c] = t0 + (t1 - t0) * fy;
    }
  }
  void sample(double lv, double px, double py, double* out) const {
    const int l = (int)lv;
    read(l, px, py, out);
    const double f = lv - l;
    if (f > 1e-4 && l + 1 < image->count) {
      double t[3];
      read(l + 1, px, py, t);
      for (int c = 0; c < 3; c++) out[c] += (t[c] - out[c]) * f;
    }
  }
  static void tapLevel(const Table& t, int l, double u, double* out) {
    const int m = t.len[l];
    const double x = u * m;
    int i0 = (int)x;
    const double f = x - i0;
    if (i0 >= m) i0 -= m;
    const int i1 = i0 + 1 == m ? 0 : i0 + 1;
    for (int c = 0; c < 3; c++) {
      const double a = t.buf[(t.off[l] + i0) * 3 + c], b = t.buf[(t.off[l] + i1) * 3 + c];
      out[c] = a + (b - a) * f;
    }
  }
  static void tap(const Table& t, double lt, double u, double* out) {
    const int l = (int)lt;
    tapLevel(t, l, u, out);
    const double f = lt - l;
    if (f > 1e-4 && l + 1 < t.count) {
      double other[3];
      tapLevel(t, l + 1, u, other);
      for (int c = 0; c < 3; c++) out[c] += (other[c] - out[c]) * f;
    }
  }
  static void tableLevels(Table& t) {
    int l = 0;
    while (t.len[l] > 2 && l + 1 < MAX_LEVELS) {
      const int m = t.len[l], n = (m + 1) / 2, dst = t.off[l] + m;
      const double r = (double)m / n;
      for (int i = 0; i < n; i++) {
        for (int side = 0; side < 2; side++) {
          double x = (i + (side ? 0.25 : -0.25)) * r;
          if (x < 0) x += m;
          int i0 = (int)x;
          const double f = x - i0;
          if (i0 >= m) i0 -= m;
          const int i1 = i0 + 1 == m ? 0 : i0 + 1;
          for (int c = 0; c < 3; c++) {
            const double a = t.buf[(t.off[l] + i0) * 3 + c], b = t.buf[(t.off[l] + i1) * 3 + c];
            const double v = 0.5 * (a + (b - a) * f);
            const int o = (dst + i) * 3 + c;
            t.buf[o] = (float)(side ? t.buf[o] + v : v);
          }
        }
      }
      l++;
      t.off[l] = dst; t.len[l] = n;
    }
    t.count = l + 1;
  }

  // polygon of `n` corners in px / py: cum + its perimeter
  double setPolygon(int n) {
    corners = n;
    cum[0] = 0;
    for (int i = 0; i < n; i++) {
      const int j = (i + 1) % n;
      cum[i + 1] = cum[i] + hypot(px[j] - px[i], py[j] - py[i]);
    }
    return cum[n];
  }
  // point at progress u (0..1) of the polygon, at an even speed (imagescan.js polyPath)
  void polyAt(double u, double& x, double& y) const {
    const double length = cum[corners];
    if (!(length > 0)) { x = px[0]; y = py[0]; return; }
    const double d = (u - floor(u)) * length;
    int i = 0;
    while (i < corners - 1 && cum[i + 1] <= d) i++;
    const double seg = cum[i + 1] - cum[i];
    const double f = seg > 0 ? (d - cum[i]) / seg : 0;
    const int j = (i + 1) % corners;
    x = px[i] + (px[j] - px[i]) * f;
    y = py[i] + (py[j] - py[i]) * f;
  }

  void build(int type, double cx, double cy, double len, double a, double b, int points, double span) {
    build(tables[current], angle, type, cx, cy, len, a, b, points, span);
  }
  void build(Table& t, double deg, int type, double cx, double cy, double len, double a, double b, int points, double span) {
    const double lv = mind(image->count - 1, maxd(0, log2(maxd(1, span / points))));
    const double r = deg * PI / 180, dx = cos(r), dy = -sin(r);
    double sum[3] = {}, out[3];
    for (int j = 0; j < points; j++) {
      const double u = (double)j / points;
      if (type == TRIANGLE || type == RECTANGLE) {
        double x, y;
        polyAt(u, x, y);
        sample(lv, x, y, out);
      } else if (type == OVAL) {
        const double lx = a * cos(2 * PI * u), ly = b * sin(2 * PI * u);
        sample(lv, cx + lx * dx + ly * dy, cy + lx * dy - ly * dx, out);
      } else {
        const double v = (u - 0.5) * len;
        sample(lv, cx + v * dx, cy + v * dy, out);
      }
      for (int c = 0; c < 3; c++) { t.buf[j * 3 + c] = (float)out[c]; sum[c] += out[c]; }
    }
    for (int c = 0; c < 3; c++) sum[c] /= points;
    for (int j = 0; j < points; j++) for (int c = 0; c < 3; c++) t.buf[j * 3 + c] = (float)(t.buf[j * 3 + c] - sum[c]);
    t.off[0] = 0; t.len[0] = points;
    tableLevels(t);
  }

  int process(const float*, const float*, float* outL, float* outR, int n) override {
    memset(outL, 0, n * sizeof(float));
    if (outR != outL) memset(outR, 0, n * sizeof(float));
    if (!image) {
      for (auto& v : voices) v.stage = 0;
      wasActive = false;
      return 0;
    }
    const int w = image->levels[0].w, h = image->levels[0].h;
    const double k = 1 - exp(-n / (0.01 * sr));
    const Stage A = stage(q[IMG_ATTACK], q[IMG_ATK_CURVE], ATTACK_KMAX);
    const Stage D = stage(q[IMG_DECAY], q[IMG_DEC_CURVE], FALL_KMAX);
    const Stage R = stage(q[IMG_RELEASE], q[IMG_REL_CURVE], FALL_KMAX);
    bool sounding = false;
    for (int i = 0; i < poly && !sounding; i++) sounding = voices[i].stage != 0;
    const int type = toInt32(q[SCAN_TYPE]);
    const bool oval = type == OVAL, box = type == OVAL || type == RECTANGLE, tri = type == TRIANGLE;
    const bool line = type == LINE || type == PROPELLOR, rest = !wasActive;
    const double target[11] = {q[X], q[Y], q[LENGTH], q[OVAL_WIDTH], q[OVAL_HEIGHT],
      q[TRI_X1], q[TRI_Y1], q[TRI_X2], q[TRI_Y2], q[TRI_X3], q[TRI_Y3]};
    for (int i = 0; i < 11; i++) g[i] = glide(!rest && haveG ? g[i] : target[i], target[i], k);
    haveG = true;
    const double rot = q[box ? OVAL_ROTATION : ROTATION];
    if (rest && type != PROPELLOR) angle = wrap(rot);
    if (type == PROPELLOR) angle = wrap(angle + q[SPEED] * 360 / sr * n);
    else {
      const double d = wrap(rot - angle);
      angle = wrap(fabs(d) < 1e-6 ? angle + d : angle + d * k);
    }
    if (!sounding) { wasActive = false; return 0; }
    const double cx = percent(g[0]) * (w - 1), cy = percent(g[1]) * (h - 1);
    double full = hypot(w - 1, h - 1); // Propellor: the diagonal
    if (type == LINE) { // imagescan.js lineSpan: edge to edge in the Line's direction
      const double r = angle * PI / 180, c = fabs(cos(r)), s = fabs(sin(r));
      full = mind(c > 1e-12 ? (w - 1) / c : INFINITY, s > 1e-12 ? (h - 1) / s : INFINITY);
    }
    const double len = percent(g[2]) * full;
    const double a = percent(g[3]) * (w - 1) / 2, b = percent(g[4]) * (h - 1) / 2;
    const double resolution = q[RESOLUTION] == q[RESOLUTION] && q[RESOLUTION] ? q[RESOLUTION] : 64;
    const int points = (int)clampd(jsRound(resolution), 2, RES_MAX);
    double tx[3] = {}, ty[3] = {};
    if (tri) for (int i = 0; i < 3; i++) { tx[i] = percent(g[5 + 2 * i]) * (w - 1); ty[i] = percent(g[6 + 2 * i]) * (h - 1); }
    const double nk[15] = {(double)type, tri ? 0 : cx, tri ? 0 : cy, line ? len : 0, box ? a : 0, box ? b : 0, tri ? 0 : angle,
      (double)points, (double)revision, tx[0], tx[1], tx[2], ty[0], ty[1], ty[2]};
    bool changed = !built, fade = false;
    for (int i = 0; i < 15 && !changed; i++) changed = nk[i] != key[i];
    if (changed) {
      fade = built && !rest;
      if (fade) current = 1 - current;
      double span = oval ? PI * (3 * (a + b) - sqrt(maxd(0, (3 * a + b) * (a + 3 * b)))) : len;
      if (tri) {
        for (int i = 0; i < 3; i++) { px[i] = tx[i]; py[i] = ty[i]; }
        span = setPolygon(3);
      } else if (type == RECTANGLE) { // imagescan.js rectCorners
        const double r = angle * PI / 180, c = cos(r), s = sin(r);
        const double lx[5] = {a, a, -a, -a, a}, ly[5] = {0, b, b, -b, -b};
        for (int i = 0; i < 5; i++) { px[i] = cx + lx[i] * c - ly[i] * s; py[i] = cy - (lx[i] * s + ly[i] * c); }
        span = setPolygon(5);
      }
      build(type, cx, cy, len, a, b, points, span);
      memcpy(key, nk, sizeof(key));
      built = true;
    }
    const Table& cur = tables[current];
    const Table& prev = tables[1 - current];
    const bool prop = type == PROPELLOR;
    double w0[6], dw[6];
    for (int side = 0; side < 2; side++) {
      double wt[3], total = 0;
      for (int c = 0; c < 3; c++) { wt[c] = clampd(q[RED_LEFT + side * 3 + c], -100, 100) / 100; total += fabs(wt[c]); }
      for (int c = 0; c < 3; c++) {
        if (total > 1) wt[c] /= total;
        const int i = side * 3 + c;
        w0[i] = !wasActive || !haveWeights ? wt[c] : weights[i];
        weights[i] = w0[i] + (wt[c] - w0[i]) * k;
        dw[i] = (weights[i] - w0[i]) / n;
      }
    }
    haveWeights = true;
    int active = 0;
    for (int vi = 0; vi < poly; vi++) {
      Voice& v = voices[vi];
      if (!v.stage) continue;
      active++;
      double vel = v.vel;
      if (v.pitch != v.pitchT) v.pitch = fabs(v.pitchT - v.pitch) < 1e-5 ? v.pitchT : v.pitch + (v.pitchT - v.pitch) * k;
      if (v.vel != v.velT) v.vel = fabs(v.velT - v.vel) < 1e-6 ? v.velT : v.vel + (v.velT - v.vel) * k;
      const double velStep = (v.vel - vel) / n;
      const double inc = incOf(v.pitch);
      // the voice's tables: the shared ones, or its own Propellor turned by its phase
      const Table* vc = &cur;
      const Table* vp = &prev;
      bool vf = fade;
      if (prop && spin[vi]) {
        if (!own[vi]) own[vi] = (Own*)calloc(1, sizeof(Own));
        Own* S = own[vi];
        if (S) {
          double ok[15];
          memcpy(ok, nk, sizeof(ok));
          ok[6] = wrap(angle + spin[vi]);
          bool changed = !S->built;
          for (int i = 0; i < 15 && !changed; i++) changed = ok[i] != S->key[i];
          vf = changed && !(fresh[vi] && !S->built);
          if (changed) {
            if (S->built) S->current = 1 - S->current;
            build(S->tables[S->current], ok[6], type, cx, cy, len, a, b, points, len);
            vp = S->built ? &S->tables[1 - S->current] : &cur; // mid-note to the Propellor: from the shared table
            memcpy(S->key, ok, sizeof(ok));
            S->built = true;
          }
          vc = &S->tables[S->current];
        }
      } else if (own[vi] && own[vi]->built) { // back to the shared table: crossfade from its own
        vf = true;
        vp = &own[vi]->tables[own[vi]->current];
        own[vi]->built = false;
      }
      fresh[vi] = false;
      const double lc = mind(vc->count - 1, maxd(0, log2(maxd(1, inc * vc->len[0]))));
      const double lp = vf ? mind(vp->count - 1, maxd(0, log2(maxd(1, inc * vp->len[0])))) : 0;
      const Stage* st = v.stage == 1 ? &A : v.stage == 2 ? &D : v.stage == 4 ? &R : nullptr;
      if (st) v.e = st->k ? exp(-st->k * v.u) : 1;
      for (int i = 0; i < n; i++) {
        switch (v.stage) {
          case 1:
            v.u += A.inc;
            if (v.u >= 1) { v.level = 1; v.stage = 2; v.u = 0; v.e = 1; }
            else { v.e *= A.m; v.level = A.k ? (1 - v.e) * A.norm : v.u; }
            break;
          case 2:
            v.u += D.inc;
            if (v.u >= 1) { v.level = q[IMG_SUSTAIN]; v.stage = 3; }
            else { v.e *= D.m; v.level = 1 + (q[IMG_SUSTAIN] - 1) * (D.k ? (1 - v.e) * D.norm : v.u); }
            break;
          case 3: v.level = q[IMG_SUSTAIN]; break;
          case 4:
            v.u += R.inc;
            if (v.u >= 1) { v.level = 0; v.stage = 0; }
            else { v.e *= R.m; v.level = v.l0 * (1 - (R.k ? (1 - v.e) * R.norm : v.u)); }
            break;
        }
        if (!v.stage) break;
        vel += velStep;
        double out[3];
        tap(*vc, lc, v.phase, out);
        if (vf) {
          double t[3]; tap(*vp, lp, v.phase, t);
          const double x = (i + 1.0) / n;
          for (int c = 0; c < 3; c++) out[c] = t[c] + (out[c] - t[c]) * x;
        }
        const double amp = v.level * vel;
        const double L = (w0[0] + dw[0] * i) * out[0] + (w0[1] + dw[1] * i) * out[1] + (w0[2] + dw[2] * i) * out[2];
        const double R = (w0[3] + dw[3] * i) * out[0] + (w0[4] + dw[4] * i) * out[1] + (w0[5] + dw[5] * i) * out[2];
        if (outR == outL) outL[i] = (float)(outL[i] + (L + R) * 0.5 * amp);
        else { outL[i] = (float)(outL[i] + L * amp); outR[i] = (float)(outR[i] + R * amp); }
        v.phase += inc;
        if (v.phase >= 1) v.phase -= 1;
      }
    }
    wasActive = active > 0;
    const double gain = q[IMG_GAIN] * 0.5;
    for (int i = 0; i < n; i++) {
      outL[i] = (float)(outL[i] * gain);
      if (outR != outL) outR[i] = (float)(outR[i] * gain);
    }
    return active > 0;
  }
};

} // namespace ms
