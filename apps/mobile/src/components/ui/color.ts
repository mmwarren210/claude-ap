/** '#RRGGBB' plus opacity as an rgba() string. */
export function alpha(hex: string, opacity: number): string {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16));
  return `rgba(${r},${g},${b},${opacity})`;
}
