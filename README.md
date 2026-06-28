# HOTA Voice Translator

中文 ↔ 多语种实时按键对讲翻译器，纯 PWA，部署在 GitHub Pages。

🌐 **线上地址**: https://liumuye1458.github.io/hota-voice-translator/

---

## 给开发者 / AI 助手

**修改这个项目前请先读 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)**。

简版规则：

> **没有对应文档，不动一行代码。**

所有文档在 [`docs/`](docs/README.md)。

---

## 给用户

1. 打开 https://liumuye1458.github.io/hota-voice-translator/
2. 点 ⚙ 设置，填入 OpenAI API Key
3. PC：按住左 Shift 说中文 / 右 Shift 说目标语言
4. 也可用微信 Ctrl+Win 把中文塞进输入框，敲左 Shift 发送

---

## 技术栈

- React 19 + Vite 7
- OpenAI: `gpt-4o`（翻译）+ `gpt-4o-transcribe`（STT）+ `gpt-4o-mini-tts`（TTS）
- 无后端，用户自带 API Key（详见 [ADR-001](docs/adr/001-no-backend.md)）

## 开发

```bash
npm install
npm run dev          # 本地开发 (http://localhost:5174/hota-voice-translator/)
npm run build        # 构建生产包
npm test             # 跑单元测试（39+ case）
```

## 部署

push 到 main → GitHub Actions 自动部署到 Pages。回滚：

```bash
git reset --hard stable-v1.0   # 紧急情况回 v1
git reset --hard stable-v2.0   # 回到 v2 稳定版
git push -f origin main
```
