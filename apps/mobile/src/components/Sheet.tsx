import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { palette } from '../theme';

export function Sheet({visible,title,onClose,children}:{visible:boolean;title:string;
  onClose:()=>void;children:ReactNode}) {
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <View style={styles.fill}>
      <Pressable style={styles.backdrop} accessibilityLabel="Close sheet" onPress={onClose} />
      <View style={styles.panel} accessibilityViewIsModal>
        <View style={styles.header}><Text style={styles.title}>{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose}
            style={styles.close}><Text style={styles.closeText}>Close</Text></Pressable></View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          {children}
        </ScrollView>
      </View>
    </View>
  </Modal>;
}
const styles=StyleSheet.create({fill:{flex:1,justifyContent:'flex-end'},
  backdrop:{...StyleSheet.absoluteFill,backgroundColor:'#000A'},
  panel:{backgroundColor:palette.card,borderTopLeftRadius:24,borderTopRightRadius:24,
    borderWidth:1,borderColor:palette.border,maxHeight:'82%',paddingBottom:22},
  header:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',padding:20},
  title:{color:palette.text,fontSize:20,fontWeight:'800'},
  close:{padding:12,minHeight:44,justifyContent:'center'},closeText:{color:palette.green,fontWeight:'700'},
  content:{paddingHorizontal:20,paddingBottom:18,gap:12}});
