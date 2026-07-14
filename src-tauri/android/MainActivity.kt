package com.folio.reader

import android.content.Context
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.os.SystemClock
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  private var webContentReady = false
  private var splashDeadline = 0L

  override fun onCreate(savedInstanceState: Bundle?) {
    splashDeadline = SystemClock.uptimeMillis() + MAX_SPLASH_HOLD_MS
    installSplashScreen().setKeepOnScreenCondition {
      !webContentReady && SystemClock.uptimeMillis() < splashDeadline
    }
    applySavedLaunchSurface()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    preferHighestRefreshRate()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.setBackgroundColor(savedLaunchBackground())
    releaseSplashAfterFirstContent(webView)
  }

  override fun onResume() {
    super.onResume()
    preferHighestRefreshRate()
  }

  private fun releaseSplashAfterFirstContent(webView: WebView, attempt: Int = 0) {
    if (webContentReady || isFinishing || isDestroyed) {
      webContentReady = true
      return
    }
    webView.evaluateJavascript(FIRST_CONTENT_PROBE) { result ->
      if (result == "true" || attempt >= MAX_CONTENT_PROBE_ATTEMPTS) {
        webContentReady = true
      } else {
        webView.postDelayed(
          { releaseSplashAfterFirstContent(webView, attempt + 1) },
          CONTENT_PROBE_INTERVAL_MS,
        )
      }
    }
  }

  private fun preferHighestRefreshRate() {
    val activeDisplay = display ?: return
    val currentMode = activeDisplay.mode
    val preferred = activeDisplay.supportedModes
      .asSequence()
      .filter {
        it.physicalWidth == currentMode.physicalWidth &&
          it.physicalHeight == currentMode.physicalHeight
      }
      .maxByOrNull { it.refreshRate }
      ?: return
    if (window.attributes.preferredDisplayModeId == preferred.modeId) return
    window.attributes = window.attributes.apply {
      preferredDisplayModeId = preferred.modeId
    }
  }

  private fun applySavedLaunchSurface() {
    val background = savedLaunchBackground()
    val darkBackground = getSharedPreferences(NATIVE_UI_PREFERENCES, Context.MODE_PRIVATE)
      .getBoolean(BOOT_DARK_KEY, false)
    window.setBackgroundDrawable(ColorDrawable(background))
    window.decorView.setBackgroundColor(background)
    WindowInsetsControllerCompat(window, window.decorView).apply {
      isAppearanceLightStatusBars = !darkBackground
      isAppearanceLightNavigationBars = !darkBackground
    }
  }

  private fun savedLaunchBackground(): Int =
    getSharedPreferences(NATIVE_UI_PREFERENCES, Context.MODE_PRIVATE)
      .getInt(BOOT_BACKGROUND_KEY, ContextCompat.getColor(this, R.color.folio_boot_background))

  private companion object {
    const val NATIVE_UI_PREFERENCES = "folio_native_ui"
    const val BOOT_BACKGROUND_KEY = "boot_background"
    const val BOOT_DARK_KEY = "boot_dark"
    const val MAX_SPLASH_HOLD_MS = 5_000L
    const val CONTENT_PROBE_INTERVAL_MS = 32L
    const val MAX_CONTENT_PROBE_ATTEMPTS = 140
    const val FIRST_CONTENT_PROBE = """
      (() => document.readyState !== 'loading' && Boolean(
        document.getElementById('folio-bootstrap') || document.querySelector('#root > *')
      ))()
    """
  }
}
