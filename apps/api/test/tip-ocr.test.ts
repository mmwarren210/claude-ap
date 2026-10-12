import assert from 'node:assert/strict';
import test from 'node:test';
import { picksInText } from '../src/tip-ocr.js';

const line = (playerName: string, market: string, value: number, platform = 'prizepicks', lineType = 'REGULAR') =>
  ({ platform, lineId: `${platform}:${playerName}:${market}:${value}:${lineType}`, playerName, market, line: value, lineType });

test('a screenshot’s text becomes board lines: name, number and stat, with the side when the slip shows it', () => {
  // What the free reader returned for a PrizePicks-style slip.
  const text = `My Lineup - 3-Pick Power Play
Drew Rasmussen
TB-P -vs NYY Mon 7:05pm
6 Pitcher Strikeouts Less
Shuai Zhang
Tennis - Mon 8:00pm
11.5 Total Games Won Less
Aaron Judge
NYY - OF - vs TB
1.5 Hits+Runs+RBIs More`;
  const lines = [line('Drew Rasmussen', 'pitcher_strikeouts', 6), line('Drew Rasmussen', 'pitcher_outs', 17.5),
    line('Drew Rasmussen', 'pitcher_strikeouts', 6, 'underdog'), line('Shuai Zhang', 'total_games_won', 11.5),
    line('Aaron Judge', 'batter_hits_runs_rbis', 1.5), line('Aaron Judge', 'batter_total_bases', 1.5),
    line('Someone Else', 'pitcher_strikeouts', 6)];
  const picks = picksInText(text, lines);
  assert.deepEqual(picks.map((pick) => [pick.line.playerName, pick.line.market, pick.line.line, pick.line.platform, pick.side]), [
    ['Drew Rasmussen', 'pitcher_strikeouts', 6, 'prizepicks', 'LESS'],
    ['Shuai Zhang', 'total_games_won', 11.5, 'prizepicks', 'LESS'],
    ['Aaron Judge', 'batter_hits_runs_rbis', 1.5, 'prizepicks', 'MORE'],
  ]);
});

test('a player whose number isn’t on the board is left out, and a slip without sides leaves the side open', () => {
  const picks = picksInText('Drew Rasmussen\n7.5 Strikeouts\nAaron Judge\n1.5 Total Bases', [line('Drew Rasmussen', 'pitcher_strikeouts', 6),
    line('Aaron Judge', 'batter_total_bases', 1.5)]);
  assert.deepEqual(picks.map((pick) => [pick.line.playerName, pick.side]), [['Aaron Judge', null]]);
});

test('the free reader reads a real slip screenshot on the server, with no AI', async () => {
  const { readFile } = await import('node:fs/promises');
  const { closeScreenshotReader, screenshotText } = await import('../src/tip-ocr.js');
  const image = (await readFile(new URL('./fixtures/tip-slip.png', import.meta.url))).toString('base64');
  const picks = picksInText(await screenshotText(image), [line('Drew Rasmussen', 'pitcher_strikeouts', 6), line('Aaron Judge', 'batter_hits_runs_rbis', 1.5),
    line('Shuai Zhang', 'total_games_won', 11.5)]);
  await closeScreenshotReader();
  assert.deepEqual(picks.map((pick) => [pick.line.playerName, pick.side]), [['Drew Rasmussen', 'LESS'], ['Shuai Zhang', 'LESS'], ['Aaron Judge', 'MORE']]);
});
