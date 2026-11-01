/* SPDX-License-Identifier: GPL-2.0-only */
/* A decoder-shaped element preserves compressed frames for LG's raw-only sink. */
#include <gst/audio/gstaudiodecoder.h>
#include <gst/base/gstadapter.h>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#include "iec61937.h"

#define BASE "/var/lib/lg-dts-native"
#define PARAMS "/sys/module/gh_dts_native/parameters/"

typedef struct {
    GstAudioDecoder parent;
    GstElement *sink;
    GThread *guard;
    gint stopping, failed;
    gint lock_fd;
    gboolean owns_route, previous_bypass;
    guint lease;
    guint rate;
    guint64 hd_frames, core_frames, dropped_frames, silent_frames;
    gint64 reported;
    guint64 gated_samples;
    gboolean last_hd, ready;
    const gchar *reason;
} GstGhDts;
typedef struct { GstAudioDecoderClass parent; } GstGhDtsClass;
G_DEFINE_TYPE(GstGhDts, gst_gh_dts, GST_TYPE_AUDIO_DECODER)

/* A refusal is reported on stderr (control.py's sys.exit), so it is kept for the GStreamer log.
 * start also passes the stream's carrier rate (0 core or 768000), fixed
 * at negotiation, so control.py never rereads hd-rate after it may have changed. */
static gboolean control(GstGhDts *self, const gchar *action, gint index, gint carrier) {
    gchar value[12], rate[12], *errors = NULL;
    gchar *arguments[] = {"/usr/bin/python3", BASE "/control.py", (gchar *)action, value, rate, NULL};
    gint status = -1;
    GError *error = NULL;
    gboolean ok;
    g_snprintf(value, sizeof(value), "%d", index);
    if (carrier < 0) arguments[4] = NULL;
    else g_snprintf(rate, sizeof(rate), "%d", carrier);
    ok = g_spawn_sync(NULL, arguments, NULL, G_SPAWN_STDOUT_TO_DEV_NULL, NULL, NULL, NULL, &errors, &status, &error) &&
        g_spawn_check_wait_status(status, &error);
    if (!ok)
        GST_WARNING_OBJECT(self, "control.py %s %d %d failed: %s; stderr: %s", action, index, carrier,
            error ? error->message : "unknown", errors && *errors ? g_strstrip(errors) : "(empty)");
    g_clear_error(&error);
    g_free(errors);
    return ok;
}

static gboolean heartbeat(GstGhDts *self) {
    gchar active[4] = {0}, value[24];
    gint fd, length;
    if (access(BASE "/enabled", R_OK)) return FALSE;
    fd = open(PARAMS "active", O_RDONLY | O_CLOEXEC);
    if (fd < 0) return FALSE;
    length = read(fd, active, sizeof(active) - 1);
    close(fd);
    if (length < 1 || active[0] != '1') return FALSE;
    fd = open(PARAMS "lease", O_WRONLY | O_CLOEXEC);
    if (fd < 0) return FALSE;
    length = g_snprintf(value, sizeof(value), "%u\n", ++self->lease);
    gboolean ok = write(fd, value, length) == length;
    close(fd);
    return ok;
}

/* The kernel sets hd_ready only once the nonPCM format, clock and eARC link
 * have been applied for a DTS-HD carrier, and clears it while it recovers. */
static gboolean hd_ready(void) {
    gchar ready[4] = {0};
    gint fd = open(PARAMS "hd_ready", O_RDONLY | O_CLOEXEC), length;
    if (fd < 0) return FALSE;
    length = read(fd, ready, sizeof(ready) - 1);
    close(fd);
    return length > 0 && ready[0] == '1';
}

/* LG's pipelines ignore GST_DEBUG, so a refusal before control.py runs, or a
 * lost lease, is kept where control.py keeps its own (the next start deletes it). */
static void record_failure(GstGhDts *self, const gchar *action, const gchar *why) {
    gchar *json = g_strdup_printf("{\"action\":\"%s\",\"error\":\"%s\"}\n", action, why);
    GST_WARNING_OBJECT(self, "native DTS %s: %s", action, why);
    g_file_set_contents(BASE "/last-error.json", json, -1, NULL);
    g_free(json);
}

static gpointer keep_route(gpointer data) {
    GstGhDts *self = data;
    while (!g_atomic_int_get(&self->stopping)) {
        if (!heartbeat(self)) {
            record_failure(self, "lease", "the route lease was lost: the module is inactive or forwarding was disabled");
            g_atomic_int_set(&self->failed, 1);
            control(self, "stop", 0, -1);
            break;
        }
        g_usleep(500000);
    }
    return NULL;
}

static void report_stream(GstGhDts *self, gboolean active);

static void release_route(GstGhDts *self) {
    if (self->owns_route) report_stream(self, FALSE);
    g_atomic_int_set(&self->stopping, 1);
    if (self->guard) { g_thread_join(self->guard); self->guard = NULL; }
    gboolean restored = !self->owns_route || control(self, "stop", 0, -1);
    /* Never reconnect the PCM mixer while a compressed route could remain. */
    if (self->sink) {
        if (restored) g_object_set(self->sink, "pcm-bypass", self->previous_bypass, NULL);
        gst_object_unref(self->sink);
        self->sink = NULL;
    }
    self->owns_route = FALSE;
    if (self->lock_fd >= 0) { close(self->lock_fd); self->lock_fd = -1; }
}

static GstElement *find_native_sink(GstGhDts *self) {
    GstObject *root = gst_object_ref(self), *parent;
    GstElement *found = NULL;
    while ((parent = gst_object_get_parent(root))) { gst_object_unref(root); root = parent; }
    if (GST_IS_BIN(root)) {
        GstIterator *iterator = gst_bin_iterate_recurse(GST_BIN(root));
        GValue item = G_VALUE_INIT;
        while (gst_iterator_next(iterator, &item) == GST_ITERATOR_OK) {
            GstElement *element = g_value_get_object(&item);
            GstElementFactory *factory = gst_element_get_factory(element);
            if (factory && !strcmp(gst_plugin_feature_get_name(GST_PLUGIN_FEATURE(factory)), "audiosink")) {
                if (found) { gst_object_unref(found); found = NULL; g_value_unset(&item); break; }
                found = gst_object_ref(element);
            }
            g_value_unset(&item);
        }
        gst_iterator_free(iterator);
    }
    gst_object_unref(root);
    return found;
}

static gboolean acquire_route(GstGhDts *self) {
    gint index = -1;
    gboolean bypass = FALSE;
    const gchar *why = "forwarding is disabled";
    if (access(BASE "/enabled", R_OK)) goto failed;
    why = "another stream owns the route";
    self->lock_fd = open(BASE "/stream.lock", O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    if (self->lock_fd < 0 || flock(self->lock_fd, LOCK_EX | LOCK_NB)) goto failed;
    why = "no single LG audiosink in the pipeline";
    self->sink = find_native_sink(self);
    if (!self->sink) goto failed;
    g_object_get(self->sink, "index", &index, "pcm-bypass", &self->previous_bypass, NULL);
    why = "audiosink renderer index is not 0 or 1";
    if (index != 0 && index != 1) goto failed;
    g_object_set(self->sink, "pcm-bypass", TRUE, NULL);
    g_object_get(self->sink, "pcm-bypass", &bypass, NULL);
    /* LG creates its renderer when the raw output caps reach audiosink. */
    why = "audiosink refused pcm-bypass or the carrier caps";
    if (!bypass || !gst_audio_decoder_negotiate(GST_AUDIO_DECODER(self))) goto failed;
    /* control.py records its own reason when it refuses. */
    why = NULL;
    if (!control(self, "start", index, (gint)self->rate)) goto failed;
    self->owns_route = TRUE;
    self->lease = 1;
    self->ready = FALSE;
    self->gated_samples = 0;
    why = "the started route is not active";
    if (!heartbeat(self)) goto failed;
    g_atomic_int_set(&self->failed, 0);
    g_atomic_int_set(&self->stopping, 0);
    self->guard = g_thread_new("dts-earc-lease", keep_route, self);
    GST_INFO_OBJECT(self, "Native DTS%s carrier on renderer %d", self->rate ? "-HD" : " core", index);
    return TRUE;
failed:
    if (why) record_failure(self, "acquire", why);
    release_route(self);
    return FALSE;
}

/* The carrier selection: 0 sends the 48 kHz core; 768000 (eight-channel HBR)
 * sends DTS-HD bursts carrying the core and its lossless and DTS:X extensions.
 * The two-channel 192 kHz carrier never locked a receiver, so anything other
 * than exactly 768000 selects the core. */
static guint carrier_rate(void) {
    gchar *text = NULL;
    guint rate = 0;
    if (g_file_get_contents(BASE "/hd-rate", &text, NULL, NULL) && !strcmp(g_strstrip(text), "768000")) rate = 768000;
    g_free(text);
    return rate;
}

/* Per-stream evidence for the controller's status: complete DTS-HD frames are
 * counted apart from cores sent alone, so a stream that lost its extensions is
 * never reported as lossless. Written by rename, about once a second and at the end. */
static void report_stream(GstGhDts *self, gboolean active) {
    gchar *json;
    gchar reason[64] = "null";
    if (!self->rate) return;
    if (self->reason) g_snprintf(reason, sizeof(reason), "\"%s\"", self->reason);
    json = g_strdup_printf("{\"active\":%s,\"carrierWordRate\":%u,\"sampleRate\":192000,\"channels\":%u,\"hdReady\":%s,"
        "\"hdFrames\":%" G_GUINT64_FORMAT ",\"coreOnlyFrames\":%" G_GUINT64_FORMAT ",\"silentFrames\":%" G_GUINT64_FORMAT
        ",\"droppedPartialFrames\":%" G_GUINT64_FORMAT ",\"lastPayload\":\"%s\",\"reason\":%s}\n",
        active ? "true" : "false", self->rate, self->rate == 768000 ? 8 : 2, self->ready ? "true" : "false",
        self->hd_frames, self->core_frames, self->silent_frames, self->dropped_frames,
        !self->ready ? "silence" : self->last_hd ? "dtshd" : "core", reason);
    g_file_set_contents(BASE "/last-stream.json", json, -1, NULL);
    g_free(json);
    self->reported = g_get_monotonic_time();
}

static GstFlowReturn refuse_stream(GstGhDts *self, const gchar *reason) {
    self->reason = reason;
    if (!self->owns_route) report_stream(self, FALSE);
    release_route(self);
    GST_ELEMENT_ERROR(self, STREAM, DECODE, ("DTS-HD forwarding could not preserve the complete frame"),
        ("%s", reason));
    return GST_FLOW_ERROR;
}

static gboolean set_format(GstAudioDecoder *decoder, GstCaps *caps) {
    GstGhDts *self = (GstGhDts *)decoder;
    GstAudioInfo info;
    (void)caps;
    /* control.py started the route for this carrier, so a renegotiation keeps
     * it rather than rereading hd-rate. */
    if (!self->owns_route) {
        self->rate = carrier_rate();
        self->hd_frames = self->core_frames = self->dropped_frames = self->silent_frames = 0;
        self->last_hd = self->ready = FALSE;
        self->gated_samples = 0;
        self->reason = NULL;
        self->reported = 0;
    }
    gst_audio_info_init(&info);
    gst_audio_info_set_format(&info, GST_AUDIO_FORMAT_S16LE, self->rate ? 192000 : 48000,
                              self->rate == 768000 ? 8 : 2, NULL);
    return gst_audio_decoder_set_output_format(decoder, &info);
}

static GstCaps *get_caps(GstAudioDecoder *decoder, GstCaps *filter) {
    /* A compressed stream's channel count is unrelated to the carrier's (two
     * for core, eight for HD), so downstream caps are not passed upstream. */
    GstCaps *caps = gst_pad_get_pad_template_caps(GST_AUDIO_DECODER_SINK_PAD(decoder));
    if (filter) {
        GstCaps *intersection = gst_caps_intersect_full(filter, caps, GST_CAPS_INTERSECT_FIRST);
        gst_caps_unref(caps);
        return intersection;
    }
    return caps;
}

/* A frame is the core, plus up to four extension substreams when DTS-HD is carried;
 * in core mode the extension is skipped by the next sync search. */
static GstFlowReturn parse_frame(GstAudioDecoder *decoder, GstAdapter *adapter, gint *offset, gint *length) {
    GstGhDts *self = (GstGhDts *)decoder;
    gsize available = gst_adapter_available(adapter), at;
    const guint8 *data;
    struct dts_core_frame frame;
    gboolean eos = FALSE;
    if (available < 10) return GST_FLOW_EOS;
    data = gst_adapter_map(adapter, available);
    for (at = 0; at + 10 <= available; at++) {
        if (dts_core_header(data + at, available - at, &frame) == 1) {
            guint total = frame.bytes;
            gint complete = 1;
            *offset = at;
            if (self->rate) {
                gst_audio_decoder_get_parse_state(decoder, NULL, &eos);
                complete = dts_hd_frame_size(data + at, available - at, &frame, eos, &total);
                /* A frame cut short by the end of the stream is never complete; it
                 * is dropped rather than sent as a core-only burst. */
                if (complete == -2) {
                    gst_adapter_unmap(adapter);
                    self->dropped_frames++;
                    GST_WARNING_OBJECT(self, "dropped %" G_GSIZE_FORMAT " bytes of an incomplete final frame", available - at);
                    *offset = available;
                    *length = 0;
                    return GST_FLOW_EOS;
                }
                if (complete < 0 || total > self->rate / 48000 * frame.samples * 4 - 20) {
                    gst_adapter_unmap(adapter);
                    return refuse_stream(self, complete == -1 ? "invalid-extension" : "payload-too-large");
                }
            }
            *length = total;
            gst_adapter_unmap(adapter);
            return complete && available - at >= total ? GST_FLOW_OK : GST_FLOW_EOS;
        }
    }
    gst_adapter_unmap(adapter);
    *offset = available - 9;
    *length = 0;
    return GST_FLOW_EOS;
}

static GstFlowReturn handle_frame(GstAudioDecoder *decoder, GstBuffer *input) {
    GstGhDts *self = (GstGhDts *)decoder;
    GstMapInfo source, destination;
    struct dts_core_frame frame;
    GstBuffer *output;
    guint size, period;
    if (!input) return GST_FLOW_OK;
    if (!gst_buffer_map(input, &source, GST_MAP_READ)) return GST_FLOW_ERROR;
    if (dts_core_header(source.data, source.size, &frame) != 1 || source.size < frame.bytes) {
        gst_buffer_unmap(input, &source);
        return GST_FLOW_ERROR;
    }
    period = self->rate ? self->rate / 48000 * frame.samples : frame.samples;
    if (self->rate && (frame.little || source.size > period * 4 - 20)) {
        gst_buffer_unmap(input, &source);
        return refuse_stream(self, frame.little ? "unsupported-core-order" : "payload-too-large");
    }
    if ((!self->owns_route && !acquire_route(self)) || g_atomic_int_get(&self->failed)) {
        gst_buffer_unmap(input, &source);
        GST_ELEMENT_ERROR(self, RESOURCE, SETTINGS, ("Native DTS eARC route is unavailable"), (NULL));
        return GST_FLOW_ERROR;
    }
    output = gst_audio_decoder_allocate_output_buffer(decoder, period * 4);
    if (!output || !gst_buffer_map(output, &destination, GST_MAP_WRITE)) {
        if (output) gst_buffer_unref(output);
        gst_buffer_unmap(input, &source);
        return GST_FLOW_ERROR;
    }
    if (self->rate) {
        size = dts_hd_burst(source.data, source.size, &frame, self->rate, destination.data);
        if (size) {
            gboolean ready = hd_ready();
            if (ready != self->ready) { self->ready = ready; self->reported = 0; }
            if (!ready) {
                /* Before hd_ready the receiver would take bursts as PCM, so the same
                 * duration of silence keeps timing and preroll intact. */
                memset(destination.data, 0, size);
                self->gated_samples += frame.samples;
                self->silent_frames++;
            } else {
                self->gated_samples = 0;
                self->last_hd = source.size > frame.bytes;
                if (self->last_hd) self->hd_frames++; else self->core_frames++;
            }
            if (g_get_monotonic_time() - self->reported >= G_USEC_PER_SEC) report_stream(self, TRUE);
        }
    } else {
        dts_core_burst(source.data, &frame, destination.data);
        size = period * 4;
    }
    gst_buffer_unmap(output, &destination);
    gst_buffer_unmap(input, &source);
    if (!size) {
        gst_buffer_unref(output);
        return refuse_stream(self, "unsupported-period");
    }
    /* Three seconds of stream time, not wall time: a paused preroll must not
     * use up the wait before the kernel has seen the stream play. */
    if (self->gated_samples > 3 * 48000) {
        gst_buffer_unref(output);
        return refuse_stream(self, "hd-not-ready");
    }
    return gst_audio_decoder_finish_frame(decoder, output, 1);
}

/* No flush vfunc: GstAudioDecoder calls it on every seek and DISCONT buffer,
 * and apps seek at start and on resume. Releasing there would restore
 * pcm-bypass on LG's live renderer, which only applies it when the renderer is
 * created. The route is released only when the stream ends or the element stops. */
static gboolean stop(GstAudioDecoder *decoder) { release_route((GstGhDts *)decoder); return TRUE; }
static gboolean sink_event(GstAudioDecoder *decoder, GstEvent *event) {
    gboolean eos = GST_EVENT_TYPE(event) == GST_EVENT_EOS;
    gboolean result = GST_AUDIO_DECODER_CLASS(gst_gh_dts_parent_class)->sink_event(decoder, event);
    if (eos) release_route((GstGhDts *)decoder);
    return result;
}

static void gst_gh_dts_init(GstGhDts *self) {
    self->lock_fd = -1;
    gst_audio_decoder_set_needs_format(GST_AUDIO_DECODER(self), TRUE);
}

static void gst_gh_dts_class_init(GstGhDtsClass *class) {
    GstElementClass *element = GST_ELEMENT_CLASS(class);
    GstAudioDecoderClass *decoder = GST_AUDIO_DECODER_CLASS(class);
    /* audio/x-private1-dts is not claimed: MPEG-PS keeps a 4-byte substream
     * header at each packet start, which lands inside frames that span packets. */
    GstCaps *input = gst_caps_from_string("audio/x-dts; audio/x-unknown,codec-id=(string)A_DTS");
    GstCaps *output = gst_caps_from_string("audio/x-raw,format=(string)S16LE,channels=(int)2,rate=(int)48000,layout=(string)interleaved; "
        "audio/x-raw,format=(string)S16LE,channels=(int)8,rate=(int)192000,layout=(string)interleaved");
    gst_element_class_add_pad_template(element, gst_pad_template_new("sink", GST_PAD_SINK, GST_PAD_ALWAYS, input));
    gst_element_class_add_pad_template(element, gst_pad_template_new("src", GST_PAD_SRC, GST_PAD_ALWAYS, output));
    gst_caps_unref(input); gst_caps_unref(output);
    gst_element_class_set_static_metadata(element, "Native DTS eARC forwarder", "Codec/Decoder/Audio",
        "Preserves DTS and DTS-HD through LG PCM bypass and non-PCM eARC", "Glasshouse contributors");
    decoder->set_format = set_format; decoder->parse = parse_frame; decoder->handle_frame = handle_frame;
    decoder->stop = stop; decoder->sink_event = sink_event; decoder->getcaps = get_caps;
}

static gboolean plugin_init(GstPlugin *plugin) {
    return gst_element_register(plugin, "dts_audiodec", GST_RANK_PRIMARY + 100, gst_gh_dts_get_type());
}
#define PACKAGE "glasshouse-dts-native"
GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, ghdts, "Native DTS eARC forwarding",
                  plugin_init, "0.1.0", "GPL", PACKAGE, "https://github.com/dakenf/lg-g5-dts")
