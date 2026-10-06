const { parseColor, contrastRatio, readableTextOn, dividerOn } = require('../../src/utils/colorContrast');

describe('colorContrast', () => {
  it('parses hex (with and without alpha) and rgb()/rgba()', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('#1C1C1C')).toEqual({ r: 28, g: 28, b: 28 });
    expect(parseColor('#1c1c1c80')).toEqual({ r: 28, g: 28, b: 28 });
    expect(parseColor('rgb(102, 102, 102)')).toEqual({ r: 102, g: 102, b: 102 });
    expect(parseColor('rgba(0 0 0 / 50%)')).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('returns null for colours it cannot read', () => {
    expect(parseColor('white')).toBeNull();
    expect(parseColor('hsl(0, 0%, 100%)')).toBeNull();
    expect(parseColor('rgb(300, 0, 0)')).toBeNull();
    expect(contrastRatio('white', '#000000')).toBeNull();
  });

  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('keeps the preferred text colour when it already reads on the panel', () => {
    // Default palette: #333333 on #f9f9f9.
    expect(readableTextOn('#f9f9f9', '#333333')).toBe('#333333');
    // Consistent dark palette: light text on a dark panel.
    expect(readableTextOn('#242424', '#e5e5e5')).toBe('#e5e5e5');
  });

  it('switches to a dark neutral for light text on a light panel', () => {
    expect(readableTextOn('#f5f5f5', '#e5e5e5')).toBe('#333333');
  });

  it('switches to a light neutral for dark text on a dark panel', () => {
    expect(readableTextOn('#242424', '#333333')).toBe('#f5f5f5');
  });

  it('leaves colours it cannot read untouched', () => {
    expect(readableTextOn('white', 'whitesmoke')).toBe('whitesmoke');
  });

  it('keeps the #eeeeee divider on light and unparseable backgrounds', () => {
    expect(dividerOn('#f9f9f9')).toBe('#eeeeee');
    expect(dividerOn('#ffffff')).toBe('#eeeeee');
    expect(dividerOn('whitesmoke')).toBe('#eeeeee');
  });

  it('lifts a dark background 10% towards white for the divider', () => {
    expect(dividerOn('#141414')).toBe('#2c2c2c');
    expect(dividerOn('#000000')).toBe('#1a1a1a');
  });
});
