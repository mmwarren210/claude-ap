import { Children } from 'react';
import type { ReactNode } from 'react';
import { Text as NativeText, TextInput as NativeTextInput } from 'react-native';
import type { TextInputProps, TextProps } from 'react-native';
import { t, useLanguage } from '../i18n';
import type { Language } from '../i18n';

// The app's Text and TextInput: React Native's, with their words shown in the chosen language (owner, 2026-10-12). A line
// built from words and values (`{count} lines`) is looked up whole first, then word by word.

function translate(children: ReactNode, language: Language): ReactNode {
  if (typeof children === 'string') return t(children, language);
  if (!Array.isArray(children)) return children;
  const parts = Children.toArray(children);
  if (parts.length && parts.every((part) => typeof part === 'string' || typeof part === 'number')) {
    const whole = parts.join(''), translated = t(whole, language);
    if (translated !== whole) return translated;
  }
  return children.map((child) => typeof child === 'string' ? t(child, language) : child);
}

export function Text(props: TextProps) {
  const language = useLanguage();
  const { children, accessibilityLabel, ...rest } = props;
  return <NativeText {...rest} accessibilityLabel={accessibilityLabel ? t(accessibilityLabel, language) : accessibilityLabel}>{translate(children, language)}</NativeText>;
}

export function TextInput(props: TextInputProps) {
  const language = useLanguage();
  const { placeholder, accessibilityLabel, ...rest } = props;
  return <NativeTextInput {...rest} placeholder={placeholder ? t(placeholder, language) : placeholder}
    accessibilityLabel={accessibilityLabel ? t(accessibilityLabel, language) : accessibilityLabel} />;
}

