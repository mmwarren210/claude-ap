import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { colors } from '../theme';

// The opening (owner, 2026-10-05): the CrownIQ logo pops in, the name and tagline roll in, then a swirling green wormhole
// opens and the app (sign-in or the board) appears through it. About 3 seconds; a tap skips it; reduced motion gets a
// short fade instead.

const appIcon = require('../../assets/images/app-icon.png') as number;
const native = Platform.OS !== 'web';
const RINGS = [
  { r: 46, dash: '18 10', width: 5, speed: 1, opacity: 0.95 },
  { r: 62, dash: '42 16', width: 4, speed: -1.4, opacity: 0.8 },
  { r: 78, dash: '8 12', width: 6, speed: 1.8, opacity: 0.7 },
  { r: 94, dash: '60 22', width: 3, speed: -2.2, opacity: 0.6 },
  { r: 110, dash: '14 18', width: 5, speed: 2.6, opacity: 0.5 },
  { r: 126, dash: '90 30', width: 3, speed: -3, opacity: 0.4 },
  { r: 142, dash: '20 26', width: 4, speed: 3.4, opacity: 0.3 },
];

export function IntroSplash({ onDone }: { onDone: () => void }) {
  const logo = useState(() => new Animated.Value(0))[0];      // 0 → 1: pop in
  const title = useState(() => new Animated.Value(0))[0];     // name rolls in
  const tagline = useState(() => new Animated.Value(0))[0];   // tagline rolls in
  const dive = useState(() => new Animated.Value(0))[0];      // 0 → 1: into the wormhole
  const spin = useState(() => new Animated.Value(0))[0];      // the swirl
  const reveal = useState(() => new Animated.Value(1))[0];    // 1 → 0: the app shows through
  const [finished, setFinished] = useState(false);
  const done = useRef(false);
  const finish = () => { if (done.current) return; done.current = true; setFinished(true); onDone(); };

  useEffect(() => {
    let cancelled = false;
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 2400, easing: Easing.linear, useNativeDriver: native }));
    void AccessibilityInfo.isReduceMotionEnabled().catch(() => false).then((reduce) => {
      if (cancelled) return;
      if (reduce) {
        Animated.sequence([Animated.timing(logo, { toValue: 1, duration: 250, useNativeDriver: native }),
          Animated.delay(500), Animated.timing(reveal, { toValue: 0, duration: 300, useNativeDriver: native })]).start(finish);
        return;
      }
      loop.start();
      Animated.sequence([
        Animated.parallel([
          Animated.spring(logo, { toValue: 1, friction: 5, tension: 70, useNativeDriver: native }),
          Animated.sequence([Animated.delay(420), Animated.timing(title, { toValue: 1, duration: 450, easing: Easing.out(Easing.cubic), useNativeDriver: native })]),
          Animated.sequence([Animated.delay(780), Animated.timing(tagline, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: native })]),
        ]),
        Animated.delay(250),
        Animated.timing(dive, { toValue: 1, duration: 1250, easing: Easing.in(Easing.cubic), useNativeDriver: native }),
        Animated.timing(reveal, { toValue: 0, duration: 380, easing: Easing.out(Easing.quad), useNativeDriver: native }),
      ]).start(finish);
    });
    return () => { cancelled = true; loop.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (finished) return null;
  const rotate = (speed: number) => spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${speed * 360}deg`] });
  // The wormhole grows out of the logo and swallows the screen; the logo and words fly in ahead of it.
  const holeScale = dive.interpolate({ inputRange: [0, 1], outputRange: [0.35, 9] });
  const holeOpacity = dive.interpolate({ inputRange: [0, 0.15, 0.85, 1], outputRange: [0, 1, 1, 0.6] });
  const brandScale = dive.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] });
  const brandOpacity = dive.interpolate({ inputRange: [0, 0.55, 0.8], outputRange: [1, 1, 0] });
  const logoScale = logo.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  const roll = (value: Animated.Value) => ({ opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [36, 0] }) }] });

  return <Animated.View style={[StyleSheet.absoluteFill, styles.root, { opacity: reveal }]} accessibilityLabel="CrownIQ" accessibilityRole="image">
    <Pressable style={StyleSheet.absoluteFill} onPress={finish} accessibilityRole="button" accessibilityLabel="Skip intro">
      <View style={styles.glow} pointerEvents="none" />
      <Animated.View pointerEvents="none" style={[styles.hole, { opacity: holeOpacity, transform: [{ scale: holeScale }] }]}>
        {RINGS.map((ring) => <Animated.View key={ring.r} style={[StyleSheet.absoluteFill, { transform: [{ rotate: rotate(ring.speed) }] }]}>
          <Svg width={320} height={320} viewBox="0 0 320 320">
            <Circle cx={160} cy={160} r={ring.r} stroke={colors.mint} strokeWidth={ring.width} strokeDasharray={ring.dash}
              strokeLinecap="round" fill="none" opacity={ring.opacity} />
          </Svg>
        </Animated.View>)}
        <View style={styles.core} />
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.center, { opacity: brandOpacity, transform: [{ scale: brandScale }] }]}>
        <Animated.View style={{ opacity: logo, transform: [{ scale: logoScale }] }}>
          <Image source={appIcon} style={styles.logo} accessibilityIgnoresInvertColors />
        </Animated.View>
        <Animated.Text style={[styles.title, roll(title)]}>Crown<Text style={styles.iq}>IQ</Text></Animated.Text>
        <Animated.Text style={[styles.tagline, roll(tagline)]}>SPORTS INTELLIGENCE · POWERED BY GKR</Animated.Text>
      </Animated.View>
    </Pressable>
  </Animated.View>;
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.background, zIndex: 1000, elevation: 1000 },
  glow: { position: 'absolute', top: '50%', left: '50%', width: 300, height: 300, marginLeft: -150, marginTop: -190, borderRadius: 150,
    backgroundColor: 'rgba(59,255,78,0.08)', shadowColor: colors.mint, shadowOpacity: 0.5, shadowRadius: 90 },
  hole: { position: 'absolute', top: '50%', left: '50%', width: 320, height: 320, marginLeft: -160, marginTop: -160 },
  core: { position: 'absolute', top: 130, left: 130, width: 60, height: 60, borderRadius: 30, backgroundColor: colors.mint,
    shadowColor: colors.mint, shadowOpacity: 1, shadowRadius: 40, opacity: 0.85 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  logo: { width: 150, height: 150, borderRadius: 34, borderWidth: 2, borderColor: colors.mint },
  title: { color: colors.text, fontSize: 56, fontWeight: '900', marginTop: 22, letterSpacing: 0.5 },
  iq: { color: colors.mint },
  tagline: { color: colors.textMuted, fontSize: 11, fontWeight: '800', letterSpacing: 1.8, marginTop: 8, textAlign: 'center' },
});
