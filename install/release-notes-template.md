<details open>
<summary><b>简体中文</b></summary>

### Coffee CLI v3.9.8 · 语音输入、提示词优化与全新的工作区

- **提示词优化：** 输入框语音按钮左侧新增“优化”入口，任务备注也能一键优化提示词，结果可以直接写回。
- **语音输入：** 输入框支持录音转文字，经 Unisound u2-asr 异步接口转写；模型设置拆分为文本与语音两套配置，并新增连通性测试。
- **工作区：** 文件树移到右栏标签，文件与预览在中间标签页打开；文本和 HTML 可切换预览/编辑，图片支持滚轮缩放与拖拽平移，Markdown 可预览或编辑，音频用独立播放器窗口打开。
- **技能：** 本地安装的技能可查看详情、卸载，右键直接打开所在文件夹；卡片显示 AI 生成的中文摘要，非 ASCII 名称也能正常列出。
- **超级助手：** Coffee Agent 统一更名为 Super Assistant，设置改为浮动对话框，用量统计并入设置。
- **更安全：** 存储的密钥改为加密保存，并接入系统钥匙串。
- **修复：** 工具配置弹窗不再被宿主对话框遮挡；同名工具重新启用时覆盖旧配置；会话已在别处打开时会说明原因。

</details>

<details>
<summary><b>English</b></summary>

### Coffee CLI v3.9.8 · Voice Input, Prompt Optimization and a New Workspace

- **Prompt optimization:** A new Optimize entry sits left of the voice button in the composer, and task notes can optimize prompts in one click, writing the result straight back.
- **Voice input:** Record and transcribe into the composer through the Unisound u2-asr async API. Model settings now split text and voice profiles, each with a connectivity test.
- **Workspace:** The file tree moves into a right-panel tab and files open in centre tabs. Text and HTML switch between preview and edit, images zoom with the wheel and pan by dragging, Markdown previews or edits, and audio opens in a standalone player window.
- **Skills:** Locally installed skills show details and uninstall actions, and a right-click opens their folder. Cards show an AI-generated Chinese summary, and non-ASCII names now list correctly.
- **Super Assistant:** Coffee Agent is renamed Super Assistant everywhere, Settings becomes a floating dialog, and usage statistics move into Settings.
- **Safer secrets:** Stored keys are encrypted and backed by the OS keychain.
- **Fixes:** Tool config modals are no longer covered by host dialogs; re-enabling a same-name tool overwrites its stale entry; a conversation already open elsewhere now explains why.

</details>

<details>
<summary><b>繁體中文</b></summary>

### Coffee CLI v3.9.8 · 語音輸入、提示詞優化與全新的工作區

- **提示詞優化：** 輸入框語音按鈕左側新增「優化」入口，任務備註也能一鍵優化提示詞，結果可直接寫回。
- **語音輸入：** 輸入框支援錄音轉文字，透過 Unisound u2-asr 非同步介面轉寫；模型設定拆分為文字與語音兩套組態，並新增連線測試。
- **工作區：** 檔案樹移到右欄標籤，檔案與預覽在中央標籤頁開啟；文字與 HTML 可切換預覽／編輯，圖片支援滾輪縮放與拖曳平移，Markdown 可預覽或編輯，音訊以獨立播放器視窗開啟。
- **技能：** 本機安裝的技能可查看詳情、解除安裝，右鍵可直接開啟所在資料夾；卡片顯示 AI 產生的中文摘要，非 ASCII 名稱也能正常列出。
- **超級助理：** Coffee Agent 統一更名為 Super Assistant，設定改為浮動對話框，用量統計併入設定。
- **更安全：** 儲存的金鑰改為加密保存，並接入系統鑰匙圈。
- **修正：** 工具設定彈窗不再被宿主對話框遮擋；同名工具重新啟用時覆蓋舊設定；工作階段已在別處開啟時會說明原因。

</details>

<details>
<summary><b>日本語</b></summary>

### Coffee CLI v3.9.8 · 音声入力、プロンプト最適化、新しいワークスペース

- **プロンプト最適化：** 入力欄の音声ボタンの左に「最適化」を追加しました。タスクのメモからもワンクリックで最適化でき、結果をそのまま書き戻せます。
- **音声入力：** Unisound u2-asr の非同期 API で録音を文字起こしして入力欄に反映します。モデル設定はテキストと音声に分かれ、それぞれ接続テストができます。
- **ワークスペース：** ファイルツリーは右パネルのタブに移動し、ファイルとプレビューは中央のタブで開きます。テキストと HTML はプレビュー／編集を切り替え、画像はホイールで拡大縮小・ドラッグで移動、Markdown はプレビューまたは編集、音声は専用プレーヤーウインドウで開きます。
- **スキル：** ローカルにインストールしたスキルの詳細表示とアンインストールに対応し、右クリックでフォルダーを開けます。カードには AI 生成の中国語要約が表示され、非 ASCII 名も正しく一覧に出ます。
- **スーパーアシスタント：** Coffee Agent を Super Assistant に統一し、設定はフローティングダイアログに、使用量統計は設定内に移動しました。
- **安全な保存：** 保存するキーを暗号化し、OS のキーチェーンに対応しました。
- **修正：** ツール設定のダイアログがホストのダイアログに隠れなくなりました。同名ツールを再度有効にすると古い設定を上書きします。会話が別の場所で開かれている場合はその旨を表示します。

</details>

<details>
<summary><b>한국어</b></summary>

### Coffee CLI v3.9.8 · 음성 입력, 프롬프트 최적화, 새로운 워크스페이스

- **프롬프트 최적화:** 입력창의 음성 버튼 왼쪽에 "최적화"를 추가했습니다. 작업 노트에서도 한 번에 최적화하고 결과를 그대로 되돌려 쓸 수 있습니다.
- **음성 입력:** Unisound u2-asr 비동기 API로 녹음을 텍스트로 변환해 입력창에 넣습니다. 모델 설정은 텍스트와 음성으로 나뉘고 각각 연결 테스트가 있습니다.
- **워크스페이스:** 파일 트리는 오른쪽 패널 탭으로 옮겼고 파일과 미리보기는 가운데 탭에서 열립니다. 텍스트와 HTML은 미리보기/편집을 오가고, 이미지는 휠로 확대하고 드래그로 이동하며, Markdown은 미리보기나 편집, 오디오는 별도 플레이어 창에서 엽니다.
- **스킬:** 로컬에 설치한 스킬의 상세 정보와 제거를 지원하고 마우스 오른쪽 버튼으로 폴더를 열 수 있습니다. 카드에는 AI가 만든 중국어 요약이 표시되고 비 ASCII 이름도 정상적으로 나열됩니다.
- **슈퍼 어시스턴트:** Coffee Agent를 Super Assistant로 통일했고, 설정은 플로팅 대화상자로, 사용량 통계는 설정 안으로 옮겼습니다.
- **안전한 보관:** 저장하는 키를 암호화하고 OS 키체인을 연동했습니다.
- **수정:** 도구 설정 대화상자가 호스트 대화상자에 가려지지 않습니다. 같은 이름의 도구를 다시 켜면 오래된 설정을 덮어씁니다. 대화가 다른 곳에서 열려 있으면 그 이유를 알려 줍니다.

</details>
