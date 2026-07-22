import { expect, test } from '@playwright/test';

async function openChat(page) {
  await page.goto('/');
  await page.getByRole('button', { name: '开始聊聊' }).click();
  await expect(page.getByRole('textbox', { name: '消息内容' })).toBeVisible();
}

async function sendMessage(page, text) {
  await page.getByRole('textbox', { name: '消息内容' }).fill(text);
  await page.getByRole('button', { name: '发送消息' }).click();
}

test('shows local privacy and safety boundaries before chat', async ({ page }) => {
  await page.goto('/');

  const boundary = page.getByRole('region', { name: '隐私和使用边界' });
  await expect(boundary).toContainText('sessionStorage');
  await expect(boundary).toContainText('未配置 API Key');
  await expect(boundary).toContainText('配置真实模型时');
  await expect(boundary).toContainText('后端默认不保存对话正文');

  await page.getByRole('button', { name: '开始聊聊' }).click();
  await expect(page.getByText('请勿输入真实身份信息')).toBeVisible();
  await expect(page.getByText('遇到紧急危险')).toBeVisible();
});

test('sends a message and renders a streamed mock reply', async ({ page }) => {
  await openChat(page);
  await sendMessage(page, '我最近很烦但不知道为什么');

  await expect(page.getByText('我最近很烦但不知道为什么')).toBeVisible();
  await expect(page.getByText(/我听见|听起来/)).toBeVisible();
  await expect(page.getByLabel('正在回应')).toBeHidden();
});

test('falls back to regular chat when the stream request fails', async ({ page }) => {
  await page.route('**/api/chat-stream', (route) => route.abort());

  await openChat(page);
  await sendMessage(page, '我最近很烦但不知道为什么');

  await expect(page.getByText(/我听见|听起来/)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('does not retry after a rate-limit response', async ({ page }) => {
  let regularChatCalls = 0;
  await page.route('**/api/chat-stream', (route) => route.fulfill({
    status: 429,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Too many requests', code: 'RATE_LIMITED' }),
  }));
  await page.route('**/api/chat', (route) => {
    regularChatCalls += 1;
    return route.continue();
  });

  await openChat(page);
  await sendMessage(page, '我最近很烦但不知道为什么');

  await expect(page.getByRole('alert')).toContainText('请求有点频繁');
  expect(regularChatCalls).toBe(0);
});

test('clears the current browser-session conversation', async ({ page }) => {
  await openChat(page);
  await sendMessage(page, '我最近很烦但不知道为什么');
  await expect(page.getByText('我最近很烦但不知道为什么')).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '清空对话' }).click();

  await expect(page.getByText('我最近很烦但不知道为什么')).toHaveCount(0);
  await expect(page.getByText('你可以从任何一句话开始')).toBeVisible();
});

test('does not persist debug payloads into session storage', async ({ page }) => {
  await page.route('**/api/chat-stream', (route) => route.fulfill({
    status: 200,
    contentType: 'application/x-ndjson',
    body: [
      JSON.stringify({
        type: 'meta',
        safety: false,
        mode: 'mock',
        debug: { knowledgeContext: { should_not_persist: true } },
      }),
      JSON.stringify({ type: 'delta', content: '这是一条测试回复。' }),
      JSON.stringify({ type: 'done' }),
      '',
    ].join('\n'),
  }));

  await openChat(page);
  await sendMessage(page, '我想测试 debug');
  await expect(page.getByText('这是一条测试回复。')).toBeVisible();

  const storedMessages = await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('mindful-chat-messages') || '[]'));
  expect(JSON.stringify(storedMessages)).not.toContain('knowledgeContext');
  expect(JSON.stringify(storedMessages)).not.toContain('should_not_persist');
});
