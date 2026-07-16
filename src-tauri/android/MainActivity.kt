package com.folio.reader
import android.content.Intent

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.folio.reader.mobile.FolioPlaybackService
import com.folio.reader.mobile.FolioSystemBarHost
import org.json.JSONObject
import java.util.Locale

open class MainActivity : TauriActivity(), FolioSystemBarHost {
  private var webContentReady = false
  private var launchOverlay: View? = null
  private var launchOverlayLogo: ImageView? = null
  private var folioWebView: WebView? = null
  private var pendingMediaLaunchIntent: Intent? = null
  private var safeTopInsetPx = 0
  private var safeRightInsetPx = 0
  private var safeBottomInsetPx = 0
  private var safeLeftInsetPx = 0
  private var insetRevision = 0

  override fun onCreate(savedInstanceState: Bundle?) {
    pendingMediaLaunchIntent = intent
    // Android's pre-process window is a stable Folio brand surface. Once this
    // Activity exists, the native overlay takes over with the exact persisted
    // reader theme until the WebView has painted matching content.
    installSplashScreen().apply {
      setKeepOnScreenCondition { false }
      setOnExitAnimationListener { provider -> provider.remove() }
    }
    applySavedLaunchSurface()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    installInsetOwner()
    installNativeLaunchOverlay()
    preferHighestRefreshRate()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // Paint the exact persisted theme behind the document before its first
    // visible frame. The native overlay remains above it until the bootstrap
    // has applied the same theme and produced real content.
    folioWebView = webView
    webView.setBackgroundColor(savedLaunchBackground())
    publishSafeInsetsToWeb(++insetRevision)
    dispatchMediaLaunchIntent(pendingMediaLaunchIntent)
    pendingMediaLaunchIntent = null
    releaseOverlayAfterThemedContent(webView)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    dispatchMediaLaunchIntent(intent)
  }

  private fun dispatchMediaLaunchIntent(intent: Intent?) {
    val bookId = intent?.getStringExtra(FolioPlaybackService.EXTRA_BOOK_ID)?.trim().orEmpty()
    if (bookId.isEmpty()) return
    val detail = JSONObject()
      .put("bookId", bookId)
      .put("page", intent?.getIntExtra(FolioPlaybackService.EXTRA_CHAPTER_INDEX, 0) ?: 0)
      .put("sentence", intent?.getIntExtra(FolioPlaybackService.EXTRA_SENTENCE_INDEX, 0) ?: 0)
      .put("chunkProgress", (intent?.getFloatExtra(FolioPlaybackService.EXTRA_CHUNK_PROGRESS, 0f) ?: 0f).coerceIn(0f, 0.98f))
      .put("locationUri", intent?.getStringExtra(FolioPlaybackService.EXTRA_LOCATION_URI).orEmpty())
    val script = "window.dispatchEvent(new CustomEvent('folio:media-launch',{detail:${detail}}));"
    val webView = folioWebView
    if (webView == null) {
      pendingMediaLaunchIntent = intent
      return
    }
    webView.postDelayed({
      if (!isFinishing && !isDestroyed) webView.evaluateJavascript(script, null)
    }, 250L)
  }

  override fun onResume() {
    super.onResume()
    preferHighestRefreshRate()
    requestAndRefreshInsets()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    requestAndRefreshInsets()
  }

  override fun onMultiWindowModeChanged(isInMultiWindowMode: Boolean) {
    super.onMultiWindowModeChanged(isInMultiWindowMode)
    requestAndRefreshInsets()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) requestAndRefreshInsets()
  }

  private fun releaseOverlayAfterThemedContent(webView: WebView, attempt: Int = 0) {
    if (webContentReady || isFinishing || isDestroyed) return
    val expectedTheme = JSONObject.quote(savedLaunchTheme())
    val insetBootstrap = insetBootstrapScript()
    val probe = """
      (() => {
        const root = document.documentElement;
        if (!(root instanceof HTMLElement)) return false;
        $insetBootstrap
        return document.readyState !== 'loading' &&
          root.dataset.folioTheme === $expectedTheme &&
          root.dataset.androidInsetsReady === 'true' &&
          root.dataset.folioWebReady === 'true';
      })()
    """.trimIndent()
    webView.evaluateJavascript(probe) { result ->
      if (result == "true") {
        webContentReady = true
        dismissNativeLaunchOverlay()
      } else if (!isFinishing && !isDestroyed) {
        val delay = if (attempt < FAST_PROBE_ATTEMPTS) CONTENT_PROBE_INTERVAL_MS else SLOW_PROBE_INTERVAL_MS
        webView.postDelayed({ releaseOverlayAfterThemedContent(webView, attempt + 1) }, delay)
      }
    }
  }

  private fun installNativeLaunchOverlay() {
    if (webContentReady || launchOverlay != null) return
    val overlay = FrameLayout(this).apply {
      setBackgroundColor(savedLaunchBackground())
      isClickable = true
      isFocusable = true
      contentDescription = "Starting Folio"
    }
    val logo = ImageView(this).apply {
      setImageResource(if (savedLaunchDark()) R.drawable.folio_boot_logo_monochrome else R.drawable.folio_boot_logo)
      scaleType = ImageView.ScaleType.FIT_CENTER
      translationY = safeTopInsetPx / 2f
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    overlay.addView(logo, FrameLayout.LayoutParams(dp(110), dp(110), Gravity.CENTER))

    val decor = window.decorView as ViewGroup
    decor.addView(overlay, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    launchOverlay = overlay
    launchOverlayLogo = logo
  }

  private fun dismissNativeLaunchOverlay() {
    val overlay = launchOverlay ?: return
    launchOverlay = null
    launchOverlayLogo = null
    (overlay.parent as? ViewGroup)?.removeView(overlay)
  }

  private fun installInsetOwner() {
    val decor = window.decorView
    ViewCompat.setOnApplyWindowInsetsListener(decor) { _, insets ->
      val safe = insets.getInsets(SAFE_INSET_TYPES)
      updateSafeInsets(safe.left, safe.top, safe.right, safe.bottom)
      insets
    }
    decor.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
      if (left != oldLeft || top != oldTop || right != oldRight || bottom != oldBottom) {
        requestAndRefreshInsets()
      }
    }
    requestAndRefreshInsets()
  }

  private fun requestAndRefreshInsets() {
    val decor = window.decorView
    ViewCompat.requestApplyInsets(decor)
    decor.post { refreshSafeInsetsFromRoot() }
    decor.postDelayed({ refreshSafeInsetsFromRoot() }, INSET_SETTLE_DELAY_MS)
  }

  private fun refreshSafeInsetsFromRoot() {
    val rootInsets = ViewCompat.getRootWindowInsets(window.decorView) ?: return
    val safe = rootInsets.getInsets(SAFE_INSET_TYPES)
    updateSafeInsets(safe.left, safe.top, safe.right, safe.bottom)
  }

  private fun updateSafeInsets(leftPx: Int, topPx: Int, rightPx: Int, bottomPx: Int) {
    val safeLeft = leftPx.coerceAtLeast(0)
    val safeTop = topPx.coerceAtLeast(0)
    val safeRight = rightPx.coerceAtLeast(0)
    val safeBottom = bottomPx.coerceAtLeast(0)
    if (
      safeTopInsetPx == safeTop && safeRightInsetPx == safeRight &&
      safeBottomInsetPx == safeBottom && safeLeftInsetPx == safeLeft
    ) return
    safeLeftInsetPx = safeLeft
    safeTopInsetPx = safeTop
    safeRightInsetPx = safeRight
    safeBottomInsetPx = safeBottom
    launchOverlayLogo?.translationY = safeTop / 2f
    publishSafeInsetsToWeb(++insetRevision)
  }

  private fun insetBootstrapScript(): String {
    val density = resources.displayMetrics.density.coerceAtLeast(1f)
    fun cssPixels(value: Int) = JSONObject.quote(String.format(Locale.US, "%.3fpx", value / density))
    val topCss = cssPixels(safeTopInsetPx)
    val rightCss = cssPixels(safeRightInsetPx)
    val bottomCss = cssPixels(safeBottomInsetPx)
    val leftCss = cssPixels(safeLeftInsetPx)
    return """
      const nextInsets = [$topCss, $rightCss, $bottomCss, $leftCss];
      const insetNames = ['--android-safe-top', '--android-safe-right', '--android-safe-bottom', '--android-safe-left'];
      const insetsChanged = root.dataset.androidInsetsReady !== 'true' ||
        insetNames.some((name, index) => root.style.getPropertyValue(name) !== nextInsets[index]);
      insetNames.forEach((name, index) => root.style.setProperty(name, nextInsets[index]));
      root.dataset.androidInsetsReady = 'true';
      if (insetsChanged) {
        window.dispatchEvent(new CustomEvent('folio:android-insets-change', {
          detail: { safeTop: nextInsets[0], safeRight: nextInsets[1], safeBottom: nextInsets[2], safeLeft: nextInsets[3] }
        }));
      }
    """.trimIndent()
  }

  private fun publishSafeInsetsToWeb(revision: Int, attempt: Int = 0) {
    val webView = folioWebView ?: return
    if (revision != insetRevision || isFinishing || isDestroyed) return
    val insetBootstrap = insetBootstrapScript()
    val script = """
      (() => {
        const root = document.documentElement;
        if (!(root instanceof HTMLElement)) return false;
        $insetBootstrap
        return true;
      })()
    """.trimIndent()
    webView.evaluateJavascript(script) { result ->
      if (result != "true" && revision == insetRevision && attempt < INSET_PUBLISH_ATTEMPTS) {
        webView.postDelayed({ publishSafeInsetsToWeb(revision, attempt + 1) }, CONTENT_PROBE_INTERVAL_MS)
      }
    }
  }

  private fun preferHighestRefreshRate() {
    val activeDisplay = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      display
    } else {
      @Suppress("DEPRECATION")
      windowManager.defaultDisplay
    } ?: return
    val currentMode = activeDisplay.mode
    val preferred = activeDisplay.supportedModes
      .asSequence()
      .filter { it.physicalWidth == currentMode.physicalWidth && it.physicalHeight == currentMode.physicalHeight }
      .maxByOrNull { it.refreshRate }
      ?: return
    if (window.attributes.preferredDisplayModeId == preferred.modeId) return
    window.attributes = window.attributes.apply { preferredDisplayModeId = preferred.modeId }
  }

  private fun applySavedLaunchSurface() {
    val background = savedLaunchBackground()
    val darkBackground = savedLaunchDark()
    window.setBackgroundDrawable(ColorDrawable(background))
    window.decorView.setBackgroundColor(background)
    applyTransparentSystemBars(darkBackground)
  }

  override fun applyFolioSystemBars(theme: String, darkBackground: Boolean, backgroundColor: Int) {
    window.setBackgroundDrawable(ColorDrawable(backgroundColor))
    window.decorView.setBackgroundColor(backgroundColor)
    launchOverlay?.setBackgroundColor(backgroundColor)
    applyTransparentSystemBars(darkBackground)
  }

  @Suppress("DEPRECATION")
  private fun applyTransparentSystemBars(darkBackground: Boolean) {
    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.TRANSPARENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.isStatusBarContrastEnforced = false
      window.isNavigationBarContrastEnforced = false
    }
    WindowInsetsControllerCompat(window, window.decorView).apply {
      isAppearanceLightStatusBars = !darkBackground
      isAppearanceLightNavigationBars = !darkBackground
    }
  }

  private fun savedLaunchTheme(): String =
    getSharedPreferences(NATIVE_UI_PREFERENCES, Context.MODE_PRIVATE)
      .getString(BOOT_THEME_KEY, "sepia")
      ?.takeIf { it in SUPPORTED_THEMES }
      ?: "sepia"

  private fun savedLaunchDark(): Boolean =
    getSharedPreferences(NATIVE_UI_PREFERENCES, Context.MODE_PRIVATE)
      .getBoolean(BOOT_DARK_KEY, false)

  private fun savedLaunchBackground(): Int =
    getSharedPreferences(NATIVE_UI_PREFERENCES, Context.MODE_PRIVATE)
      .getInt(BOOT_BACKGROUND_KEY, ContextCompat.getColor(this, R.color.folio_boot_sepia))

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()

  private companion object {
    const val NATIVE_UI_PREFERENCES = "folio_native_ui"
    const val BOOT_BACKGROUND_KEY = "boot_background"
    const val BOOT_DARK_KEY = "boot_dark"
    const val BOOT_THEME_KEY = "boot_theme"
    const val CONTENT_PROBE_INTERVAL_MS = 32L
    const val SLOW_PROBE_INTERVAL_MS = 250L
    const val FAST_PROBE_ATTEMPTS = 140
    const val INSET_PUBLISH_ATTEMPTS = 180
    const val INSET_SETTLE_DELAY_MS = 160L
    val SAFE_INSET_TYPES =
      WindowInsetsCompat.Type.systemBars() or
        WindowInsetsCompat.Type.displayCutout() or
        WindowInsetsCompat.Type.mandatorySystemGestures()
    val SUPPORTED_THEMES = setOf("sepia", "light", "dark", "folio", "blackleaf")
  }
}
