; Lightee 卸载增补。
;
; electron-builder 会在卸载流程里插入这个宏，位置在「删除已安装文件」之前
; （见 app-builder-lib/templates/nsis/uninstaller.nsh，customUnInstall 的插入点
; 排在 RMDir /r $INSTDIR 前面）。这里补两件模板顾不到的事。

!macro customUnInstall

  ; 变量声明必须在宏**内部**。electron-builder 分两趟编译：卸载器一趟、安装器一趟，
  ; 而 customUnInstall 只在卸载器那一趟展开。放在文件顶层的话，安装器那一趟会看到
  ; 一个声明了却无人引用的变量，NSIS 报 warning 6001，而这里的警告是当错误处理的，
  ; 整个打包直接失败。electron-builder 自己的 isDeleteAppData 也是声明在段内。
  Var /GLOBAL lighteePurgeData

  ; ——— 一、卸载后残留的空目录 ———
  ;
  ; 卸载器在 un.onInit 里执行过 `SetOutPath $INSTDIR`，把自己的**当前工作目录**
  ; 设成了安装目录。而 Windows 不允许删除任何进程的当前工作目录，于是随后的
  ; `RMDir /r $INSTDIR` 把里面的文件全删光，却留下一个空壳目录——两次实测都是
  ; 0 文件 0 子目录，正是这个原因。
  ;
  ; 把工作目录挪到 $TEMP 即可。后续的删除、快捷方式、注册表操作用的都是绝对
  ; 路径，不依赖当前目录，改动是安全的。
  SetOutPath "$TEMP"

  ; ——— 二、本机数据 ———
  ;
  ; 默认保留。卸载后重装、在安装版与 Scoop 之间换渠道，在实践里都很常见，
  ; 数据一旦跟着应用走，一次误操作就没了译稿。所以只有两种情况才清：
  ;
  ;   1. 命令行带 --delete-app-data。这是 electron-builder 自带的开关，它自己会清
  ;      %APPDATA%\lightee-electron；这里补上它不可能知道的 ~/.lightee。
  ;   2. 交互式卸载时用户明确选「是」（对话框默认「否」）。
  ;
  ; ${isUpdated} 这道闸不能少：**自动更新走的也是这套卸载流程**，在那里删数据
  ; 等于每次更新都把用户的设置和历史清空。electron-builder 自己的 app-data 清理
  ; 同样加了这道闸。
  StrCpy $lighteePurgeData "0"

  ${ifNot} ${isUpdated}
    ClearErrors
    ${GetParameters} $R0
    ${GetOptions} $R0 "--delete-app-data" $R1
    ${ifNot} ${errors}
      StrCpy $lighteePurgeData "1"
    ${else}
      ; 静默卸载而又没给开关 —— 一律保留，不弹窗（弹了也没人能点）。
      ${ifNot} ${Silent}
        MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除本机上的设置与翻译历史？$\r$\n$\r$\n包含 API Key、模型配置与调用历史。$\r$\n你的译稿工作区不在其中，不会被删除。$\r$\n$\r$\n选「否」将保留这些数据，重新安装后可继续使用。" /SD IDNO IDYES lighteePurgeYes
        Goto lighteePurgeDone
        lighteePurgeYes:
        StrCpy $lighteePurgeData "1"
        lighteePurgeDone:
      ${endif}
    ${endif}
  ${endif}

  ${if} $lighteePurgeData == "1"
    RMDir /r "$PROFILE\.lightee"
    ; userData 目录名取自打包后 package.json 的 name（lightee-electron），
    ; 不是 productName（Lightee）——electron-builder 不会把两者对齐。
    ;
    ; 走命令行开关时 electron-builder 后面会自己清这一份；但交互式选「是」
    ; 时它不会，因为它只认命令行。两条路径的结果必须一致，所以这里显式补上。
    ; 对已不存在的目录再删一次是无害的。
    RMDir /r "$APPDATA\lightee-electron"
  ${endif}

!macroend
