; Установщик Hearth (NSIS 3, Unicode). Сборка: makensis -DVER=1.4.0 -DSRC=<dist/win-unpacked> installer/hearth.nsi
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef VER
  !define VER "1.4.0"
!endif
!ifndef SRC
  !define SRC "..\dist"
!endif
!ifndef OUT
  !define OUT "..\dist\Hearth-Setup-${VER}.exe"
!endif

!define APP "Hearth"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Hearth"

Name "${APP} ${VER}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\Hearth"
InstallDirRegKey HKCU "Software\Hearth" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
BrandingText "Hearth ${VER}"

VIProductVersion "${VER}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Hearth"
VIAddVersionKey /LANG=1033 "FileDescription" "Hearth Setup"
VIAddVersionKey /LANG=1033 "FileVersion" "${VER}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VER}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "MIT License"

!define MUI_ICON "..\build\hearth.ico"
!define MUI_UNICON "..\build\hearth.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Hearth.exe"
!define MUI_FINISHPAGE_RUN_TEXT "$(T_RUN)"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE DirLeave
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

LangString T_RUN ${LANG_RUSSIAN} "Запустить Hearth"
LangString T_RUN ${LANG_ENGLISH} "Launch Hearth"
LangString T_CORE ${LANG_RUSSIAN} "Hearth (обязательно)"
LangString T_CORE ${LANG_ENGLISH} "Hearth (required)"
LangString T_DESK ${LANG_RUSSIAN} "Ярлык на рабочем столе"
LangString T_DESK ${LANG_ENGLISH} "Desktop shortcut"
LangString T_BUSY ${LANG_RUSSIAN} "Hearth сейчас запущен. Закройте его (кнопка «Выйти из Hearth» в левом нижнем углу окна) и нажмите «Повтор»."
LangString T_BUSY ${LANG_ENGLISH} "Hearth is running. Close it (the 'Quit Hearth' button at the bottom left) and click Retry."
LangString T_PURGE ${LANG_RUSSIAN} "Удалить также данные Hearth (серверы, бэкапы, настройки) из $APPDATA\Hearth?$\r$\n$\r$\nВыберите «Нет», если планируете установить Hearth снова."
LangString T_PURGE ${LANG_ENGLISH} "Also delete Hearth data (servers, backups, settings) from $APPDATA\Hearth?$\r$\n$\r$\nChoose No if you plan to reinstall Hearth."

Function DirLeave
  ; Если выбрана чужая папка (например, Документы), ставим в её подпапку Hearth: деинсталлятор удаляет папку целиком
  ${GetFileName} "$INSTDIR" $0
  ${If} $0 != "Hearth"
    StrCpy $INSTDIR "$INSTDIR\Hearth"
  ${EndIf}
FunctionEnd

Function WaitForExeFree
  ; exe, пока Hearth работает, занят системой: пытаемся удалить его и просим закрыть программу
  retry:
  IfFileExists "$INSTDIR\Hearth.exe" 0 done
  ClearErrors
  Delete "$INSTDIR\Hearth.exe"
  IfErrors 0 done
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(T_BUSY)" /SD IDCANCEL IDRETRY retry
  Abort
  done:
FunctionEnd

Section "$(T_CORE)" SecCore
  SectionIn RO
  SetOutPath "$INSTDIR"
  Call WaitForExeFree
  ; вся папка приложения: Hearth.exe, Chromium, код и ядро; чужие файлы в папке установки не трогаем (см. DirLeave)
  File /r "${SRC}\*.*"
  File "..\build\hearth.ico"
  ; Файл-признак: установленная версия хранит данные в %APPDATA%\Hearth
  FileOpen $0 "$INSTDIR\installed.flag" w
  FileWrite $0 "installed by Hearth Setup ${VER}$\r$\n"
  FileClose $0

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\Hearth"
  CreateShortcut "$SMPROGRAMS\Hearth\Hearth.lnk" "$INSTDIR\Hearth.exe" "" "$INSTDIR\hearth.ico" 0
  CreateShortcut "$SMPROGRAMS\Hearth\Uninstall Hearth.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "Software\Hearth" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Hearth"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VER}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Hearth"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\hearth.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "$(T_DESK)" SecDesktop
  CreateShortcut "$DESKTOP\Hearth.lnk" "$INSTDIR\Hearth.exe" "" "$INSTDIR\hearth.ico" 0
SectionEnd

Section "Uninstall"
  Call un.WaitForExeFree
  ; папка установки называется Hearth (DirLeave): удаляем её целиком.
  ; Папку от старых версий с другим именем не сносим: только свои файлы.
  ${GetFileName} "$INSTDIR" $0
  ${If} $0 == "Hearth"
    RMDir /r "$INSTDIR"
  ${Else}
    Delete "$INSTDIR\Hearth.exe"
    Delete "$INSTDIR\hearth.ico"
    Delete "$INSTDIR\README.txt"
    Delete "$INSTDIR\installed.flag"
    Delete "$INSTDIR\Uninstall.exe"
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\locales"
    RMDir "$INSTDIR"
  ${EndIf}
  Delete "$SMPROGRAMS\Hearth\Hearth.lnk"
  Delete "$SMPROGRAMS\Hearth\Uninstall Hearth.lnk"
  RMDir "$SMPROGRAMS\Hearth"
  Delete "$DESKTOP\Hearth.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\Hearth"
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(T_PURGE)" IDNO keep
    RMDir /r "$APPDATA\Hearth"
    keep:
  ${EndIf}
SectionEnd

Function un.WaitForExeFree
  retry:
  IfFileExists "$INSTDIR\Hearth.exe" 0 done
  ClearErrors
  Delete "$INSTDIR\Hearth.exe"
  IfErrors 0 done
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(T_BUSY)" /SD IDCANCEL IDRETRY retry
  Abort
  done:
FunctionEnd
