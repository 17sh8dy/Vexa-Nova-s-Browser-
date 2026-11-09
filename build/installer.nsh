; Extra NSIS steps for the Vexa installer (referenced from package.json -> build.nsis.include).
; Registration as a browser is done by the app itself at runtime (src/main/default-browser.js);
; the uninstaller just removes what that created.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\VexaURL"
  DeleteRegKey HKCU "Software\Classes\VexaHTML"
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Vexa"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Vexa"
!macroend
