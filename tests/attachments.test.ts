import { describe, expect, it } from 'vitest';
import { createAttachmentRecord, sanitizeAttachment, sanitizeAttachments } from '../src/attachments';

describe('attachment Firestore payloads', () => {
  it('omits unavailable optional metadata instead of returning undefined fields', () => {
    const attachment = sanitizeAttachment({
      id: 'attachment-1',
      kind: 'image',
      url: 'https://example.test/image.jpg',
      name: 'image.jpg',
      size: 123,
      mimeType: 'image/jpeg',
      width: undefined,
      height: undefined,
      duration: undefined,
    });

    expect(attachment).not.toHaveProperty('width');
    expect(attachment).not.toHaveProperty('height');
    expect(attachment).not.toHaveProperty('duration');
  });

  it('keeps valid dimensions and filters invalid attachment entries', () => {
    const file = new File(['image'], 'image.jpg', { type: 'image/jpeg' });
    const created = createAttachmentRecord(file, 'https://example.test/image.jpg', {
      width: 1200,
      height: 800,
    });
    const attachments = sanitizeAttachments([created, null, undefined]);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ width: 1200, height: 800 });
    expect(Object.values(attachments[0])).not.toContain(undefined);
  });
});
