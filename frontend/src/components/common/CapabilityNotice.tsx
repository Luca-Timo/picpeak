import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';

/**
 * Tells the visitor a feature is paused for a moment, when the server refuses
 * one (config/api.ts raises the event). Calm and specific: the rest of the app
 * keeps working. The toast id stops repeated refusals from stacking.
 */
export const CapabilityNotice: React.FC = () => {
  const { t, i18n } = useTranslation();

  useEffect(() => {
    const show = (event: Event) => {
      const capability = (event as CustomEvent<unknown>).detail;
      if (typeof capability !== 'string') return;
      const key = `capabilityNotice.${capability}`;
      if (!i18n.exists(key, { keySeparator: false })) return;
      toast.info(t(key, { keySeparator: false }), { toastId: key });
    };
    window.addEventListener('picpeak:capability-unavailable', show);
    return () => window.removeEventListener('picpeak:capability-unavailable', show);
  }, [t, i18n]);

  return null;
};
