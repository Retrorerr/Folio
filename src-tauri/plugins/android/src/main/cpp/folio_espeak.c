#include <jni.h>
#include <android/log.h>
#include <espeak-ng/speak_lib.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define LOG_TAG "FolioEspeak"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

#define MAX_INPUT_BYTES (64U * 1024U)
#define MAX_OUTPUT_BYTES (1024U * 1024U)

typedef struct {
    char *data;
    size_t length;
    size_t capacity;
} output_buffer;

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static int g_initialized = 0;

static void throw_java(JNIEnv *env, const char *class_name, const char *message) {
    if ((*env)->ExceptionCheck(env)) {
        return;
    }
    jclass exception = (*env)->FindClass(env, class_name);
    if (exception != NULL) {
        (*env)->ThrowNew(env, exception, message);
        (*env)->DeleteLocalRef(env, exception);
    }
}

static int reserve_output(output_buffer *output, size_t additional) {
    if (additional > MAX_OUTPUT_BYTES || output->length > MAX_OUTPUT_BYTES - additional) {
        return 0;
    }
    const size_t required = output->length + additional + 1;
    if (required <= output->capacity) {
        return 1;
    }

    size_t grown_capacity = output->capacity == 0 ? 512 : output->capacity;
    while (grown_capacity < required) {
        if (grown_capacity > MAX_OUTPUT_BYTES / 2) {
            grown_capacity = MAX_OUTPUT_BYTES + 1;
            break;
        }
        grown_capacity *= 2;
    }
    if (grown_capacity > MAX_OUTPUT_BYTES + 1) {
        return 0;
    }

    char *grown = (char *)realloc(output->data, grown_capacity);
    if (grown == NULL) {
        return 0;
    }
    output->data = grown;
    output->capacity = grown_capacity;
    return 1;
}

static int append_bytes(output_buffer *output, const char *value, size_t length) {
    if (length == 0) {
        return 1;
    }
    if (!reserve_output(output, length)) {
        return 0;
    }
    memcpy(output->data + output->length, value, length);
    output->length += length;
    output->data[output->length] = '\0';
    return 1;
}

static int append_space_if_needed(output_buffer *output) {
    if (output->length == 0 || output->data[output->length - 1] == ' ') {
        return 1;
    }
    return append_bytes(output, " ", 1);
}

static int is_ascii_space(unsigned char value) {
    return value == ' ' || value == '\t' || value == '\r' || value == '\n' || value == '\f';
}

/*
 * Return the UTF-8 width of punctuation represented in Kokoro's vocabulary.
 * Apostrophes intentionally remain in the text segment so contractions are
 * phonemized as words instead of being split into two unrelated clauses.
 */
static size_t punctuation_width(const unsigned char *value, size_t remaining) {
    if (remaining == 0) {
        return 0;
    }
    switch (value[0]) {
        case ';':
        case ':':
        case ',':
        case '.':
        case '!':
        case '?':
        case '"':
        case '(':
        case ')':
            return 1;
        default:
            break;
    }
    if (remaining >= 3 && value[0] == 0xE2 && value[1] == 0x80) {
        if (value[2] == 0x94 || value[2] == 0xA6 || value[2] == 0x9C || value[2] == 0x9D) {
            return 3; /* em dash, ellipsis, left quote, right quote */
        }
    }
    return 0;
}

static int phonemize_segment(const char *value, size_t length, output_buffer *output) {
    if (length == 0) {
        return 1;
    }

    size_t start = 0;
    while (start < length && is_ascii_space((unsigned char)value[start])) {
        ++start;
    }
    size_t end = length;
    while (end > start && is_ascii_space((unsigned char)value[end - 1])) {
        --end;
    }
    if (start == end) {
        return append_space_if_needed(output);
    }
    if (start > 0 && !append_space_if_needed(output)) {
        return 0;
    }

    const size_t segment_length = end - start;
    char *segment = (char *)malloc(segment_length + 1);
    if (segment == NULL) {
        return 0;
    }
    memcpy(segment, value + start, segment_length);
    segment[segment_length] = '\0';

    const void *cursor = segment;
    int chunks = 0;
    int ok = 1;
    /*
     * Match the desktop phonemizer's `tie="^"` contract. Misaki's fallback
     * normalizer depends on that marker for multi-codepoint IPA phonemes such
     * as syllabic `ə^l`, which it maps to Kokoro's compact `ᵊl` token.
     */
    const int phoneme_mode = espeakPHONEMES_IPA | espeakPHONEMES_TIE |
        (((int)'^') << 8);
    while (cursor != NULL && chunks++ < 2048) {
        const void *previous_cursor = cursor;
        const char *phonemes = espeak_TextToPhonemes(
            &cursor,
            espeakCHARS_UTF8,
            phoneme_mode
        );
        if (phonemes != NULL && phonemes[0] != '\0') {
            if (output->length > 0 && output->data[output->length - 1] != ' ' &&
                chunks > 1 && !append_space_if_needed(output)) {
                ok = 0;
                break;
            }
            if (!append_bytes(output, phonemes, strlen(phonemes))) {
                ok = 0;
                break;
            }
        }
        if (cursor == previous_cursor) {
            LOGE("eSpeak NG did not advance while phonemizing input");
            ok = 0;
            break;
        }
    }
    if (chunks >= 2048 && cursor != NULL) {
        LOGE("eSpeak NG exceeded the clause safety limit");
        ok = 0;
    }
    free(segment);
    return ok;
}

JNIEXPORT jboolean JNICALL
Java_com_folio_reader_mobile_EspeakPhonemizer_nativeInitialize(
    JNIEnv *env, jobject self, jstring data_path) {
    (void)self;
    if (data_path == NULL) {
        throw_java(env, "java/lang/IllegalArgumentException", "eSpeak data path is missing");
        return JNI_FALSE;
    }

    const char *path = (*env)->GetStringUTFChars(env, data_path, NULL);
    if (path == NULL) {
        return JNI_FALSE;
    }

    pthread_mutex_lock(&g_lock);
    if (!g_initialized) {
        const int sample_rate = espeak_Initialize(
            AUDIO_OUTPUT_SYNCHRONOUS,
            0,
            path,
            espeakINITIALIZE_DONT_EXIT
        );
        if (sample_rate <= 0) {
            LOGE("espeak_Initialize failed for %s", path);
        } else {
            g_initialized = 1;
        }
    }
    const int initialized = g_initialized;
    pthread_mutex_unlock(&g_lock);

    (*env)->ReleaseStringUTFChars(env, data_path, path);
    if (!initialized) {
        throw_java(env, "java/lang/IllegalStateException", "eSpeak NG could not initialize");
    }
    return initialized ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_com_folio_reader_mobile_EspeakPhonemizer_nativePhonemize(
    JNIEnv *env, jobject self, jstring text, jstring language) {
    (void)self;
    if (text == NULL) {
        throw_java(env, "java/lang/IllegalArgumentException", "Text is missing");
        return NULL;
    }

    const jsize input_length = (*env)->GetStringUTFLength(env, text);
    if (input_length <= 0 || (uint32_t)input_length > MAX_INPUT_BYTES) {
        throw_java(env, "java/lang/IllegalArgumentException", "Text is empty or too long to phonemize safely");
        return NULL;
    }
    if (language != NULL) {
        const jsize language_length = (*env)->GetStringUTFLength(env, language);
        if (language_length <= 0 || language_length > 32) {
            throw_java(env, "java/lang/IllegalArgumentException", "eSpeak NG language code is invalid");
            return NULL;
        }
    }

    const char *input = (*env)->GetStringUTFChars(env, text, NULL);
    const char *lang = language == NULL ? "en-us" : (*env)->GetStringUTFChars(env, language, NULL);
    if (input == NULL || lang == NULL) {
        if (input != NULL) {
            (*env)->ReleaseStringUTFChars(env, text, input);
        }
        if (language != NULL && lang != NULL) {
            (*env)->ReleaseStringUTFChars(env, language, lang);
        }
        return NULL;
    }

    output_buffer output = {0};
    int ok = 1;
    pthread_mutex_lock(&g_lock);
    if (!g_initialized) {
        ok = 0;
        throw_java(env, "java/lang/IllegalStateException", "eSpeak NG is not initialized");
    } else {
        espeak_VOICE voice_spec;
        memset(&voice_spec, 0, sizeof(voice_spec));
        voice_spec.languages = lang;
        if (espeak_SetVoiceByProperties(&voice_spec) != EE_OK) {
            ok = 0;
            throw_java(env, "java/lang/IllegalArgumentException", "eSpeak NG voice is unavailable");
        }
    }
    if (ok) {
        size_t segment_start = 0;
        size_t index = 0;
        const size_t total = (size_t)input_length;
        while (index < total) {
            const size_t punctuation = punctuation_width(
                (const unsigned char *)input + index,
                total - index
            );
            if (punctuation == 0) {
                ++index;
                continue;
            }
            if (!phonemize_segment(input + segment_start, index - segment_start, &output) ||
                !append_bytes(&output, input + index, punctuation)) {
                ok = 0;
                break;
            }
            index += punctuation;
            segment_start = index;
        }
        if (ok && !phonemize_segment(input + segment_start, total - segment_start, &output)) {
            ok = 0;
        }
    }
    pthread_mutex_unlock(&g_lock);

    jstring result = NULL;
    if (ok && output.length > 0) {
        result = (*env)->NewStringUTF(env, output.data);
    } else if (ok) {
        throw_java(env, "java/lang/IllegalArgumentException", "Text produced no phonemes");
    } else if (!(*env)->ExceptionCheck(env)) {
        throw_java(env, "java/lang/IllegalStateException", "eSpeak NG could not phonemize the input safely");
    }

    free(output.data);
    (*env)->ReleaseStringUTFChars(env, text, input);
    if (language != NULL) {
        (*env)->ReleaseStringUTFChars(env, language, lang);
    }
    return result;
}
