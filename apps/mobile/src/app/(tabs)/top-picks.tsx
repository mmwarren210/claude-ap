import type { RankingCard, SecondLookCard } from '@crowniq/contracts';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Notice, Screen } from '../../components/Screen';
import { palette } from '../../theme';
import { useBoard } from '../../use-board';
import { useRankings } from '../../use-rankings';

type Card = RankingCard | SecondLookCard;

function ResultCard({card,watchlist=false}:{card:Card;watchlist?:boolean}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`View ${card.playerName}`}
    onPress={()=>router.push({pathname:'/player/[lineId]',params:{lineId:card.lineId}})}
    style={styles.card}>
    <Text style={styles.number}>{watchlist?'WATCH':'#'+card.rank} · {card.sport} · {card.lineType}</Text>
    {card.reviewStatus==='SECOND_LOOK' &&
      <Text style={styles.secondLook}>2ND LOOK · {watchlist?'research further':'re-checked after initial PASS'}</Text>}
    <Text style={styles.name}>{card.playerName}</Text>
    <Text style={styles.detail}>{card.team ?? '—'} vs {card.opponent ?? '—'} · {card.eventName}</Text>
    <Text style={styles.detail}>{card.direction} {card.threshold} {card.market}</Text>
    <Text style={styles.score}>CrownIQ {card.score} · {card.scoreBand} · {card.modelVersion}</Text>
  </Pressable>;
}

export default function RankingsScreen() {
  const { freshness, nowMs } = useBoard();
  const { status, data, message, retry } = useRankings();
  const rankings=data?.rankings.filter((card)=>Date.parse(card.eventStartTime)>nowMs)??[];
  const watchlist=data?.watchlist.filter((card)=>Date.parse(card.eventStartTime)>nowMs)??[];
  if(!data)return <Screen eyebrow="CROWNIQ  /  MODEL OUTPUT" title="Rankings">
    <Notice title={status==='loading'?'Loading rankings':'Rankings pending'}
      detail={message || 'Checking the saved full-board analysis.'} />
    <Pressable accessibilityRole="button" onPress={retry}>
      <Text style={styles.sectionTitle}>Retry rankings</Text>
    </Pressable>
  </Screen>;
  return <Screen eyebrow="CROWNIQ  /  MODEL OUTPUT" title="Rankings">
    <Text style={styles.score}>{freshness} board</Text>
    {freshness==='SNAPSHOT' && <Text style={styles.score}>Saved rankings remain available before event start. Check that each line is still offered before playing.</Text>}
    <Pressable accessibilityRole="button" onPress={retry}>
      <Text style={styles.sectionTitle}>Refresh rankings</Text>
    </Pressable>
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>PRIMARY RANKINGS</Text>
      <Text style={styles.sectionDetail}>Only CrownIQ outputs scoring 80 or higher.</Text>
      {rankings.length ? rankings.map((card)=><ResultCard key={card.lineId} card={card} />) :
        <Notice title="No primary rankings"
          detail="No 80+ supported model outputs right now. PASS remains a valid result." />}
    </View>
    {watchlist.length>0 && <View style={styles.section}>
      <Text style={styles.sectionTitle}>2ND LOOK WATCHLIST</Text>
      <Text style={styles.sectionDetail}>Re-researched LEAN/WEAK outputs. Review the evidence before acting.</Text>
      {watchlist.map((card)=><ResultCard key={card.lineId} card={card} watchlist />)}
    </View>}
  </Screen>;
}

const styles = StyleSheet.create({
  section:{gap:10,marginTop:8},
  sectionTitle:{color:palette.green,fontSize:13,fontWeight:'900',letterSpacing:1.4},
  sectionDetail:{color:palette.muted,fontSize:12,lineHeight:18,marginBottom:2},
  card:{backgroundColor:palette.card,borderWidth:1,borderColor:palette.border,
    borderRadius:18,padding:17,gap:6},
  number:{color:palette.green,fontSize:11,fontWeight:'800',letterSpacing:1},
  name:{color:palette.text,fontSize:18,fontWeight:'800'},
  detail:{color:palette.text,fontSize:14},
  score:{color:palette.muted,fontSize:12},
  secondLook:{color:palette.green,fontSize:10,fontWeight:'800',letterSpacing:1},
});
