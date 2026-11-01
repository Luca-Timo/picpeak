import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const info = vi.hoisted(() => vi.fn());
vi.mock('react-toastify', () => ({ toast: { info } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { exists: (key: string) => key === 'capabilityNotice.uploads.new' },
  }),
}));

import { CapabilityNotice } from '../CapabilityNotice';
import { publicUploadErrorKey } from '../../../utils/publicUploadErrors';

const raise = (detail: unknown) => window.dispatchEvent(new CustomEvent('picpeak:capability-unavailable', { detail }));

describe('CapabilityNotice', () => {
  beforeEach(() => info.mockClear());
  afterEach(cleanup);

  it('shows one toast per capability', () => {
    render(<CapabilityNotice />);
    raise('uploads.new');
    expect(info).toHaveBeenCalledWith('capabilityNotice.uploads.new', { toastId: 'capabilityNotice.uploads.new' });
  });

  it('ignores a capability it has no text for', () => {
    render(<CapabilityNotice />);
    raise('something.else');
    raise(42);
    expect(info).not.toHaveBeenCalled();
  });

  it('gives upload screens a localized message for the refusal', () => {
    expect(publicUploadErrorKey('CAPABILITY_UNAVAILABLE')).toBe('upload.capacity.unavailable');
  });
});
