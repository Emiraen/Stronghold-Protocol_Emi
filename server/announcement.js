/* eslint-disable no-unsafe-finally */
import { readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function validateAnnouncement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'title') || !Object.hasOwn(value, 'content')) {
    throw new Error('公告参数无效');
  }
  for (const [key, max] of [['title', 80], ['content', 3000]]) {
    const text = value[key];
    if (typeof text !== 'string' || !text.trim() || text.length > max || !text.isWellFormed()
      || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
      || (key === 'title' && /[\r\n\t]/.test(text))) throw new Error('公告须为必填纯文本，标题最多80字，内容最多3000字');
  }
  return { title: value.title, content: value.content };
}

export function createAnnouncementStore({ file = null, initialFile = null } = {}) {
  let current = { title: '', content: '', updatedAt: 0 };
  const source = file || initialFile;
  if (source) {
    try {
      const value = JSON.parse(readFileSync(source, 'utf8'));
      const text = validateAnnouncement({ title: value.title, content: value.content });
      // 兼容既有手工公告使用的 ISO 日期字符串，运行时统一为毫秒版本。
      const updatedAt = typeof value.updatedAt === 'string' ? Date.parse(value.updatedAt) : value.updatedAt ?? 0;
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new Error('公告版本无效');
      current = { ...text, updatedAt };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return {
    read: () => ({ ...current }),
    publish(value) {
      const next = { ...validateAnnouncement(value), updatedAt: Math.max(Date.now(), current.updatedAt + 1) };
      if (file) {
        const temp = `${file}.${randomUUID()}.tmp`;
        let fd;
        try {
          fd = openSync(temp, 'wx', 0o644);
          writeFileSync(fd, JSON.stringify(next, null, 2) + '\n', 'utf8');
          fsyncSync(fd);
          closeSync(fd); fd = undefined;
          renameSync(temp, file);
        } finally { // eslint-disable-line no-unsafe-finally
          if (fd !== undefined) closeSync(fd);
          try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      // 只有原子替换成功才更新内存和通知在线会话。
      current = next;
      return { ...current };
    },
    apply(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) throw new Error('公告版本无效');
      if (value.updatedAt < current.updatedAt || (value.updatedAt === current.updatedAt && value.updatedAt !== 0)) return { ...current };
      // 旧版公告没有时间戳；以主服的零版本内容覆盖附服随包携带的初始公告。
      if (value.updatedAt === 0 && value.title === '' && value.content === '') {
        current = { title: '', content: '', updatedAt: 0 };
        return { ...current };
      }
      const text = validateAnnouncement({ title: value.title, content: value.content });
      current = { ...text, updatedAt: value.updatedAt };
      return { ...current };
    },
  };
}
