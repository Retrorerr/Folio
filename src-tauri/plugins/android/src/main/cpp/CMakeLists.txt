cmake_minimum_required(VERSION 3.22.1)

project(folio_espeak LANGUAGES C)

set(ESPEAK_SOURCE_DIR "" CACHE PATH "Path to the official eSpeak NG source checkout")
if(NOT ESPEAK_SOURCE_DIR OR NOT EXISTS "${ESPEAK_SOURCE_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "ESPEAK_SOURCE_DIR must point to an eSpeak NG source checkout")
endif()

# eSpeak is statically linked into the small JNI bridge. This keeps the Android
# runtime from having to resolve a second native library and lets the app load
# the same phonemizer on every supported ABI.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(COMPILE_INTONATIONS OFF CACHE BOOL "" FORCE)
set(ENABLE_TESTS OFF CACHE BOOL "" FORCE)
set(USE_MBROLA OFF CACHE BOOL "" FORCE)
set(USE_LIBSONIC OFF CACHE BOOL "" FORCE)
set(USE_LIBPCAUDIO OFF CACHE BOOL "" FORCE)
set(USE_SPEECHPLAYER OFF CACHE BOOL "" FORCE)
set(USE_ASYNC OFF CACHE BOOL "" FORCE)
set(ESPEAK_COMPAT OFF CACHE BOOL "" FORCE)

add_subdirectory("${ESPEAK_SOURCE_DIR}" espeak-ng EXCLUDE_FROM_ALL)

add_library(folio_espeak SHARED folio_espeak.c)
target_include_directories(folio_espeak PRIVATE "${ESPEAK_SOURCE_DIR}/src/include")
target_link_libraries(folio_espeak PRIVATE espeak-ng log)

# NDK r27 does not enable flexible-page-size output by default. Android 15+
# devices can use 16 KiB pages, so both PT_LOAD alignment values must be 16 KiB
# even though Folio still supports devices with 4 KiB pages.
target_link_options(folio_espeak PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,-z,common-page-size=16384"
)
