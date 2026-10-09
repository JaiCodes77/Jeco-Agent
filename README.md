# Jeco Agent

Local Brave side panel. It acts only on sites you add. The OpenRouter key stays in the extension.

## Load it

```bash
npm install
npm test
npm run build
```

1. Open `brave://extensions`.
2. Turn on Developer mode.
3. Load unpacked and choose the `dist` folder.
4. Click the Jeco icon.
5. In Settings, save your OpenRouter key and add a site such as `youtube.com`.

Page text from each step is sent to OpenRouter so the model can choose the next action. Passwords, cookies, and payments are not.
