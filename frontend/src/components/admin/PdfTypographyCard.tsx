/**
 * Settings → Branding card: lets the admin pick the font used on every
 * PDF (quotes, invoices, tax report) from the bundled families. Sits
 * directly after the web-typography section on `BrandingPage`.
 *
 * Loads the same `/public/fonts` list the web font picker consumes, so
 * any family bundled in `backend/assets/fonts/` shows up here too
 * automatically. The selected value persists to
 * `business_profile.pdf_font_family` and pdfService maps it to
 * `<family>/400.ttf` (body) + `<family>/700.ttf` (bold) at render time.
 *
 * Hidden by the caller when no PDF-producing feature is enabled
 * (quotes / bills / taxReport all off) — when there's no PDF surface
 * the setting is irrelevant.
 */
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Save, Type } from 'lucide-react';
import { Card, Button } from '../common';
import { businessProfileService } from '../../services/businessProfile.service';
import { fontsService } from '../../services/fonts.service';

/**
 * The bundled-fonts API returns the DISPLAY name (e.g. "Playfair
 * Display") but pdfService resolves a DIRECTORY name (e.g.
 * "Playfair-Display"). They're always related by space ↔ hyphen.
 * The helpers below convert between them so the dropdown can show
 * a clean human label while persisting the on-disk identifier.
 */
const familyToDirectory = (family: string) => family.replace(/ /g, '-');
const directoryToFamily = (dir: string) => dir.replace(/-/g, ' ');

export const PdfTypographyCard: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Load the current profile so we can hydrate the dropdown with its
  // saved value. Mirrors the pattern other Settings → Business
  // profile fields already use.
  const { data: snapshot, isLoading } = useQuery({
    queryKey: ['business-profile-snapshot'],
    queryFn: () => businessProfileService.get(),
    staleTime: 5 * 60 * 1000,
  });
  // Same query the web typography picker consumes — single source of
  // truth for "which bundled families exist on disk".
  const { data: availableFonts } = useQuery({
    queryKey: ['fonts'],
    queryFn: () => fontsService.list(),
    staleTime: 60 * 60 * 1000, // fonts don't change at runtime
  });

  const [selection, setSelection] = useState<string>('');

  useEffect(() => {
    if (snapshot?.profile?.pdfFontFamily) {
      setSelection(snapshot.profile.pdfFontFamily);
    } else {
      setSelection('');
    }
  }, [snapshot?.profile?.pdfFontFamily]);

  const isDirty = (snapshot?.profile?.pdfFontFamily || '') !== selection;

  const save = useMutation({
    mutationFn: () =>
      businessProfileService.update({
        // Empty string in the UI means "no preference"; send null so
        // the column is cleared rather than stored as ''.
        pdfFontFamily: selection ? selection : null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['business-profile-snapshot'] });
      toast.success(t('branding.pdfFontSavedToast', 'PDF font saved.'));
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.error || err?.message || 'Save failed');
    },
  });

  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1 flex items-center gap-2">
        <Type className="w-5 h-5" />
        {t('branding.pdfTypography', 'PDF typography')}
      </h3>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
        {t('branding.pdfTypographyHelp',
          'Used for invoice + quote letterheads. Pick one of the bundled fonts, or leave on default to use Helvetica.')}
      </p>

      <div className="flex flex-col md:flex-row md:items-end md:gap-3">
        <div className="flex-1">
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
            {t('branding.pdfFontFamily', 'Body font')}
          </label>
          <select
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
            className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
            disabled={isLoading}
          >
            <option value="">
              {t('branding.pdfFontFamilyDefault', 'Use Helvetica (default)')}
            </option>
            {(availableFonts || []).map((f) => (
              <option key={f.family} value={familyToDirectory(f.family)}>
                {/* Show the display name (with spaces) — but persist
                    the directory name (with hyphens) so pdfService can
                    find the on-disk family without an extra lookup. */}
                {f.family}
              </option>
            ))}
            {/* When the saved value points at a family that's no
                longer on disk (e.g. uploaded by an earlier admin,
                later removed), still show it so the admin sees what
                they have rather than silently re-mapping to default. */}
            {selection && !(availableFonts || []).some((f) => familyToDirectory(f.family) === selection) && (
              <option value={selection}>
                {directoryToFamily(selection)} ({t('branding.pdfFontFamilyMissing', 'missing')})
              </option>
            )}
          </select>
        </div>
        <div className="mt-3 md:mt-0">
          <Button
            onClick={() => save.mutate()}
            disabled={!isDirty || save.isPending}
            isLoading={save.isPending}
            leftIcon={<Save className="w-4 h-4" />}
          >
            {t('common.save', 'Save')}
          </Button>
        </div>
      </div>
    </Card>
  );
};
