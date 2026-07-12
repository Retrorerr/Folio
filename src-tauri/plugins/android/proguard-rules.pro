# Rules used if the Android library itself is minified. The application-level
# R8 pass receives the equivalent runtime boundary rules from consumer-rules.pro.
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations,AnnotationDefault,Signature,InnerClasses,EnclosingMethod
-keep @app.tauri.annotation.TauriPlugin class * { *; }
-keep @app.tauri.annotation.InvokeArg class * { <fields>; }
-keepclassmembers class * {
    @app.tauri.annotation.Command <methods>;
    @app.tauri.annotation.ActivityCallback <methods>;
}
-keep class com.folio.reader.mobile.EspeakPhonemizer { native <methods>; }
-keep class com.folio.reader.mobile.FolioPlaybackService { public <init>(); *; }
-keep class com.folio.reader.mobile.PlaybackStateInitializer { public <init>(); *; }
-keep class ai.onnxruntime.** { *; }
-keepclasseswithmembernames,includedescriptorclasses class * { native <methods>; }
