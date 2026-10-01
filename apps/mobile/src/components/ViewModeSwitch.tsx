import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ViewMode } from '../state';
import { palette } from '../theme';

export function ViewModeSwitch({value,onChange}:{value:ViewMode;onChange:(mode:ViewMode)=>void}){
  return <View style={styles.row} accessibilityLabel="Board view mode">
    {(['LITE','FULL'] as const).map((mode)=><Pressable key={mode} accessibilityRole="button"
      accessibilityLabel={`${mode==='LITE'?'Lite, top ranked plays':'Full, entire board'} view`}
      accessibilityState={{selected:value===mode}} onPress={()=>onChange(mode)}
      style={[styles.button,value===mode&&styles.selected]}>
      <Text style={[styles.text,value===mode&&styles.active]}>{mode==='LITE'?'Lite':'Full'}</Text>
    </Pressable>)}
  </View>;
}
const styles=StyleSheet.create({row:{flexDirection:'row',borderWidth:1,borderColor:palette.border,
  borderRadius:14,overflow:'hidden',alignSelf:'flex-start'},button:{minWidth:104,minHeight:48,
  paddingHorizontal:20,justifyContent:'center',alignItems:'center'},selected:{backgroundColor:palette.greenDim},
  text:{color:palette.muted,fontSize:14,fontWeight:'700'},active:{color:palette.green}});
