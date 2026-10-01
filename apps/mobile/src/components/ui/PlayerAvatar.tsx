import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../../theme';
import { alpha } from './color';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/** Player photo in a colored ring. Falls back to initials when there is no photo or it fails to load. */
export function PlayerAvatar({ name, photoUrl, ring = colors.mint, size = 64 }: { name: string;
  photoUrl?: string | null; ring?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const inner = size - 6;
  return <View style={[styles.ring, { width: size, height: size, borderRadius: size / 2, borderColor: ring,
    shadowColor: ring }]} accessibilityLabel={`${name} photo`}>
    <View style={[styles.inner, { width: inner, height: inner, borderRadius: inner / 2,
      backgroundColor: alpha(ring, 0.14) }]}>
      {photoUrl && !failed
        ? <Image source={{ uri: photoUrl }} style={{ width: inner, height: inner }} contentFit="cover"
          contentPosition="top" transition={150} onError={() => setFailed(true)} cachePolicy="memory-disk" />
        : <Text style={[styles.initials, { fontSize: inner * 0.36, color: ring }]}>{initials(name)}</Text>}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  ring: { borderWidth: 2.5, alignItems: 'center', justifyContent: 'center', shadowOpacity: 0.55,
    shadowRadius: 8, shadowOffset: { width: 0, height: 0 } },
  inner: { overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  initials: { fontWeight: '900', letterSpacing: 0.5 },
});
