# Tauri discovers plugin commands and invoke-argument fields from runtime
# annotations/reflection. Keep annotation metadata and only the annotated API.
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations,AnnotationDefault,Signature,InnerClasses,EnclosingMethod
-keep @app.tauri.annotation.TauriPlugin class * { *; }
-keep @app.tauri.annotation.InvokeArg class * { <fields>; }
-keepclassmembers class * {
    @app.tauri.annotation.Command <methods>;
    @app.tauri.annotation.ActivityCallback <methods>;
}

# The JNI symbols exported by libfolio_espeak.so encode this class and method
# name, so neither may be renamed by the consuming application's R8 pass.
-keep class com.folio.reader.mobile.EspeakPhonemizer {
    native <methods>;
}

# Android instantiates these manifest components by their class names.
-keep class com.folio.reader.mobile.FolioPlaybackService { public <init>(); *; }
-keep class com.folio.reader.mobile.PlaybackStateInitializer { public <init>(); *; }

# ONNX Runtime uses JNI/reflection for tensor and session types. Its AAR also
# supplies consumer rules, but keeping the public JNI boundary here protects
# Folio if that upstream packaging changes.
-keep class ai.onnxruntime.** { *; }
-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}
