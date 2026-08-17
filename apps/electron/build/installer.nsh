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
  ; **只认命令行开关，不弹任何对话框。** 这是硬约束，不是取舍：
  ;
  ; 卸载器会把自己复制成 Un_A.exe 再重启一遍，`/S` 在那一跳上未必跟得过去；
  ; 而 MessageBox MB_YESNO 的默认焦点在「是」上，`/SD IDNO` 又只在真正静默时
  ; 才起作用。两件事叠在一起，一次本该「什么都不删」的普通卸载就可能把用户的
  ; 设置、API Key 与全部调用历史删干净——实测发生过一次，无法恢复。
  ;
  ; 所以普通卸载必须在**结构上**不可能删数据：没有分支能走到删除，除非命令行
  ; 明确给了 --delete-app-data。若日后要在卸载界面上提供「顺便清数据」，走
  ; electron-builder 的 customUnWelcomePage 复选框（默认不勾）单独立票，
  ; 且每条路径实测过才能上。
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
    ${endif}
  ${endif}

  ${if} $lighteePurgeData == "1"
    ; 数据根是 $APPDATA\Lightee（app.setPath("userData") 显式指定，见 user-data-root.js）。
    ; electron-builder 自带的清理认的是 productFilename 与 package name 两个名字，
    ; 前者正好等于 Lightee，所以新根它会自己删；这里补的是它不可能知道的旧址，
    ; 以及迁移时留下的备份副本——「完整卸载」就该是完整的，留一个备份目录在那里
    ; 等于用户以为清干净了其实没有。
    RMDir /r "$PROFILE\.lightee"
    RMDir /r "$PROFILE\.lightee.migrated"
    RMDir /r "$APPDATA\lightee-electron.migrated"
  ${endif}

!macroend
