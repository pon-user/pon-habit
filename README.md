# 習慣化アプリ ぽん — GitHub Pages 公開ひな形

**このフォルダーだけでは公開できません。** 次の1つを追加してください。

1. Obsidianの `99_Note/20261014_習慣化アプリ_App_v6.jsx` をGitHubのRaw表示からダウンロードする。
2. ファイル名を `App.jsx` に変更する。
3. このフォルダーの `src/` に置く。 `src/main.jsx` と同じ場所に `App.jsx` が必要。
4. GitHubで新しい**公開**リポジトリを作成し、README以外のファイルも含めたこのフォルダーの**中身**をアップロードする（ZIPそのものはアップロードしない）。
5. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする。
6. **Actions** タブから `Deploy Habit App` の成功を確認し、**Settings → Pages** に表示されるURLを開く。

## ファイル配置（完成形）

    index.html
    package.json
    vite.config.js
    README.md
    src/
      main.jsx
      App.jsx       ← 自分で追加
    .github/
      workflows/
        deploy.yml

リポジトリ名は自由に決めて構いません。 `vite.config.js` はGitHub Actions上でリポジトリ名を自動取得します。

## 注意

- ReactのJSXはブラウザで直接動きません。このひな形はGitHub ActionsによってViteで静的ページへビルドします。
- GitHub Pagesで公開したURLには誰でもアクセス可能です。習慣の実績は端末のlocalStorageに保存され、リポジトリに自動同期しません。
- 初期リリース向けv6はロジックテスト済みですが、Reactビルド・iPhone実機テストは未実施です。ビルド失敗したらActionsのBuild React appのエラーを確認してください。
