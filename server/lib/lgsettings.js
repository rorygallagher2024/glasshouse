/*
 * LG's own settings shown as a switch, a choice or a number, one row each.
 *
 * A row names the key in LG's settings service, its category, and the values
 * LG stores: for a switch, those for on and off; for a choice, each value
 * with its label; for a number, the range. store: 'string' is for a number
 * LG keeps as text, as it does the sound settings.
 *
 * port and column place an HDMI input's rows in the dashboard's table.
 *
 * greyable: LG greys out an HDMI input's settings while another input is on
 * screen, and these follow that. It greys other settings too - sound mode
 * while sound is not on the TV speakers - which stay changeable here.
 *
 * unless: another key in the same category that, where the TV has it, takes
 * this row's place - a C2 keeps one Deep Colour for the input on screen, and
 * still reports the per-port keys a B8 uses, set to off and unused.
 *
 * Choices and ranges differ between TVs - a B8 has six sound modes where a C2
 * has eight - so each is narrowed to what the TV's settings service describes
 * as visible. It is offered only where the TV reports the key,
 * so a TV without one (a B8 has no screen saver promotion) does not show it.
 * Adding a setting is adding a row here, with its strings; both dashboards
 * render the rows as they come.
 *
 * Each category is read whole, one call for all its rows: asking for a key
 * the TV does not have fails the whole call on some firmware. Sound is then
 * read again by name, for the keys the whole read returned (see collect).
 *
 * Strict ES5 for node 0.12 on webOS 4.
 */
var msg = require('./say').msg;
var names = require('./names');

// The levels LG offers for most of its picture processing.
var LEVELS = {
  off: msg('srv.lgs.level.off', 'Off'),
  low: msg('srv.lgs.level.low', 'Low'),
  medium: msg('srv.lgs.level.medium', 'Medium'),
  high: msg('srv.lgs.level.high', 'High'),
  auto: msg('srv.lgs.level.auto', 'Auto')
};
function lmh(value) { return { value: value, label: LEVELS[value] }; }

/*
 * A row of the Picture tab. Like LG's own app, a change to one marks the
 * picture mode as adjusted (pictureSettingModified), which is what offers
 * Reset for it in LG's menu; modified: false is for the rows LG's app does
 * not mark, such as the mode itself. hideable: LG's menu leaves out a setting
 * it reports as not visible, such as Dynamic Tone Mapping for SDR video or
 * Local Dimming on an OLED, and so does the tab.
 */
function picture(r) {
  r.section = 'picture';
  if (!r.category) r.category = 'picture';
  r.greyable = true;
  r.hideable = true;
  if (r.modified !== false) r.modified = true;
  return r;
}

var CMS_DESC = {
  Saturation: msg('srv.lgs.cms.saturation.desc', 'How strong this colour is, without changing the others.'),
  Hue: msg('srv.lgs.cms.hue.desc', 'Shifts this colour towards its neighbours on the colour wheel.'),
  Luminance: msg('srv.lgs.cms.luminance.desc', 'How bright this colour is, without changing the others.')
};
function cms(colour, property, title) {
  var name = colour.charAt(0).toUpperCase() + colour.slice(1);
  return picture({ id: 'cms' + property + name, group: 'cms', cms: colour, part: property.toLowerCase(),
    key: 'colorManagement' + property + name, type: 'number', min: -30, max: 30, title: title, desc: CMS_DESC[property] });
}

// LG's ads and promotions. Each is 'on' when the ads show; the names and
// meanings are those of LG's own Settings menu on webOS 9.2.
var ROWS = [
  { id: 'screenSaverAd', section: 'promotions', category: 'general', key: 'screenSaverAd', on: 'on', off: 'off',
    title: msg('srv.lgs.screenSaverAd', 'Screen saver ads'),
    desc: msg('srv.lgs.screenSaverAd.desc', 'Adverts that some apps, such as LG Channels, show in the screen saver. LG calls this Screen Saver Promotion.') },
  { id: 'homePromotion', section: 'promotions', category: 'general', key: 'homePromotion', on: 'on', off: 'off',
    title: msg('srv.lgs.homePromotion', 'Sponsored tiles on Home'),
    desc: msg('srv.lgs.homePromotion.desc', 'Adverts marked Sponsored on the Home screen. LG calls this Home Promotion.') },
  { id: 'contentRecommendation', section: 'promotions', category: 'other', key: 'contentRecommendation', on: 'on', off: 'off',
    title: msg('srv.lgs.contentRecommendation', 'Recommendations on Home'),
    desc: msg('srv.lgs.contentRecommendation.desc', 'Rows of recommended programmes and films on the Home screen. LG calls this Content Recommendation.') },
  { id: 'livePromotion', section: 'promotions', category: 'option', key: 'livePromotion', on: 'on', off: 'off',
    title: msg('srv.lgs.livePromotion', 'Ads while watching'),
    desc: msg('srv.lgs.livePromotion.desc', 'Adverts and offers shown over what is on screen, while LG\'s Live Plus is on. LG calls this Live Promotion.') },
  { id: 'aiNudge', section: 'promotions', category: 'general', key: 'aiNudge', on: 'on', off: 'off',
    title: msg('srv.lgs.aiNudge', 'Smart tips'),
    desc: msg('srv.lgs.aiNudge.desc', 'Suggestions for TV features that pop up while watching or using an app. LG calls this Smart Tips.') },
  { id: 'aiSettingsNudge', section: 'promotions', category: 'general', key: 'aiSettingsNudge', on: 'on', off: 'off',
    title: msg('srv.lgs.aiSettingsNudge', 'Smart tips in Settings'),
    desc: msg('srv.lgs.aiSettingsNudge.desc', 'Suggested settings shown in LG\'s Settings menu. LG calls this Smart Tips in Settings.') },

  // LG's Game Optimizer, from its own app on webOS 9.2. LG keeps these for the
  // game input and genre in use, which it reports as the category's
  // dimension, and applies them while the picture mode is Game Optimizer.
  { id: 'gameGenre', section: 'game', category: 'other', key: 'gameGenre', type: 'choice',
    choices: [
      { value: 'Standard', label: msg('srv.lgs.gameGenre.standard', 'Standard') },
      { value: 'FPS', label: msg('srv.lgs.gameGenre.fps', 'First-person shooter') },
      { value: 'RPG', label: msg('srv.lgs.gameGenre.rpg', 'Role-playing') },
      { value: 'RTS', label: msg('srv.lgs.gameGenre.rts', 'Real-time strategy') },
      { value: 'Sports', label: msg('srv.lgs.gameGenre.sports', 'Sports') },
      { value: 'USER', label: msg('srv.lgs.gameGenre.user', 'User') }
    ],
    title: msg('srv.lgs.gameGenre', 'Game genre'),
    desc: msg('srv.lgs.gameGenre.desc', 'Tunes the picture for the kind of game. Each genre keeps its own stabilizer settings.') },
  { id: 'inputOptimization', section: 'game', category: 'other', key: 'inputOptimization', type: 'choice',
    choices: [
      { value: 'auto', label: msg('srv.lgs.inputOptimization.auto', 'Standard') },
      { value: 'on', label: msg('srv.lgs.inputOptimization.on', 'Boost') }
    ],
    title: msg('srv.lgs.inputOptimization', 'Prevent input delay'),
    desc: msg('srv.lgs.inputOptimization.desc', 'Standard cuts input lag for the kind of content; Boost cuts it further by matching the console\'s frame rate.') },
  { id: 'gameOptimization', section: 'game', category: 'other', key: 'gameOptimization', on: 'on', off: 'off',
    title: msg('srv.lgs.gameOptimization', 'VRR & G-Sync'),
    desc: msg('srv.lgs.gameOptimization.desc', 'Lets the TV follow the frame rate a console or PC sends, so motion stays smooth without tearing.') },
  { id: 'freesync', section: 'game', category: 'other', key: 'freesync', on: 'on', off: 'off',
    title: msg('srv.lgs.freesync', 'AMD FreeSync Premium'),
    desc: msg('srv.lgs.freesync.desc', 'The same for AMD graphics cards and consoles that use FreeSync.') },
  { id: 'enableALLM', section: 'game', category: 'other', key: 'enableALLM', on: 'on', off: 'off',
    title: msg('srv.lgs.enableALLM', 'ALLM'),
    desc: msg('srv.lgs.enableALLM.desc', 'Switches the TV to its low-latency game mode by itself when a connected device starts a game.') },
  { id: 'darkMode', section: 'game', category: 'other', key: 'darkMode', type: 'choice',
    choices: [
      { value: 'off', label: msg('srv.lgs.darkMode.off', 'Off') },
      { value: 'level1', label: msg('srv.lgs.darkMode.level1', 'Level 1') },
      { value: 'level2', label: msg('srv.lgs.darkMode.level2', 'Level 2') }
    ],
    title: msg('srv.lgs.darkMode', 'Dark room mode'),
    desc: msg('srv.lgs.darkMode.desc', 'Lowers the brightness for playing in a dark room.') },
  { id: 'blackStabilizer', section: 'game', category: 'other', key: 'blackStabilizer', type: 'number', min: 0, max: 20,
    title: msg('srv.lgs.blackStabilizer', 'Black stabilizer'),
    desc: msg('srv.lgs.blackStabilizer.desc', 'Lifts dark areas so detail in shadows is easier to see.') },
  { id: 'whiteStabilizer', section: 'game', category: 'other', key: 'whiteStabilizer', type: 'number', min: 0, max: 20,
    title: msg('srv.lgs.whiteStabilizer', 'White stabilizer'),
    desc: msg('srv.lgs.whiteStabilizer.desc', 'Tames bright areas so detail in highlights is easier to see.') },
  { id: 'aigamesound', section: 'game', category: 'sound', key: 'aigamesound', on: 'on', off: 'off',
    title: msg('srv.lgs.aigamesound', 'AI Game Sound'),
    desc: msg('srv.lgs.aigamesound.desc', 'Sets the sound for the game being played: effects, clear voices and surround.') },

  // Sound, as LG's Sound menu names it. The Control tab switches the output
  // too; it is here as well, beside the settings that depend on it. The
  // English is names.js's for each output, keyed here for translation.
  { id: 'soundOutput', section: 'sound', category: 'sound', key: 'soundOutput', type: 'choice',
    choices: [
      { value: 'tv_speaker', label: msg('srv.lgs.soundOutput.tvSpeaker', 'TV Speaker') },
      { value: 'external_arc', label: msg('srv.lgs.soundOutput.externalArc', 'HDMI ARC') },
      { value: 'external_optical', label: msg('srv.lgs.soundOutput.externalOptical', 'Optical') },
      { value: 'bt_soundbar', label: msg('srv.lgs.soundOutput.btSoundbar', 'Bluetooth') },
      { value: 'headphone', label: msg('srv.lgs.soundOutput.headphone', 'Headphone / AUX') },
      { value: 'tv_speaker_external_arc', label: msg('srv.lgs.soundOutput.tvSpeakerExternalArc', 'TV Speaker + HDMI ARC') },
      { value: 'tv_speaker_bluetooth', label: msg('srv.lgs.soundOutput.tvSpeakerBluetooth', 'TV Speaker + Bluetooth') },
      { value: 'tv_speaker_headphone', label: msg('srv.lgs.soundOutput.tvSpeakerHeadphone', 'TV Speaker + Headphone') }
    ],
    title: msg('srv.lgs.soundOutput', 'Sound output'),
    desc: msg('srv.lgs.soundOutput.desc', 'Where the TV plays its sound. Sound mode and balance apply only to the TV speakers.') },
  { id: 'soundMode', section: 'sound', category: 'sound', key: 'soundMode', type: 'choice',
    choices: [
      { value: 'aiSoundPlus', label: msg('srv.lgs.soundMode.aiSoundPlus', 'AI Sound Pro') },
      { value: 'aiSound', label: msg('srv.lgs.soundMode.aiSound', 'AI Sound') },
      { value: 'standard', label: msg('srv.lgs.soundMode.standard', 'Standard') },
      { value: 'news', label: msg('srv.lgs.soundMode.news', 'Clear Voice') },
      { value: 'movie', label: msg('srv.lgs.soundMode.movie', 'Cinema') },
      { value: 'sports', label: msg('srv.lgs.soundMode.sports', 'Sports') },
      { value: 'music', label: msg('srv.lgs.soundMode.music', 'Music') },
      { value: 'game', label: msg('srv.lgs.soundMode.game', 'Game Optimizer') }
    ],
    title: msg('srv.lgs.soundMode', 'Sound mode'),
    desc: msg('srv.lgs.soundMode.desc', 'How the TV tunes its sound, through its own speakers only. AI Sound Pro adjusts it to what is on by itself.') },
  { id: 'soundOutputDigital', section: 'sound', category: 'sound', key: 'soundOutputDigital', type: 'choice',
    choices: [
      { value: 'auto', label: msg('srv.lgs.soundOutputDigital.auto', 'Auto') },
      { value: 'pcm', label: msg('srv.lgs.soundOutputDigital.pcm', 'PCM') },
      { value: 'passThrough', label: msg('srv.lgs.soundOutputDigital.passThrough', 'Pass Through') }
    ],
    title: msg('srv.lgs.soundOutputDigital', 'Digital sound output'),
    desc: msg('srv.lgs.soundOutputDigital.desc', 'The audio sent to a soundbar or receiver over HDMI ARC/eARC or optical. Pass Through requests encoded audio; PCM sends decoded audio.') },
  { id: 'audioBalance', section: 'sound', category: 'sound', key: 'audioBalance', type: 'number', min: -50, max: 50, store: 'string',
    title: msg('srv.lgs.audioBalance', 'Balance'),
    desc: msg('srv.lgs.audioBalance.desc', 'Between the left and right TV speakers, and only those. At 0 both play at the same level.') },
  { id: 'autoVolume', section: 'sound', category: 'sound', key: 'autoVolume', on: 'on', off: 'off',
    title: msg('srv.lgs.autoVolume', 'Automatic volume'),
    desc: msg('srv.lgs.autoVolume.desc', 'Keeps the volume level when switching channels. LG calls this Automatic Volume Adjustment.') },

  { id: 'btSpeakerMode', section: 'sound', category: 'general', key: 'blueToothSpeakerMode', on: 'on', off: 'off',
    title: msg('srv.lgs.btSpeakerMode', 'Bluetooth speaker mode'),
    desc: msg('srv.lgs.btSpeakerMode.desc', 'Lets phones in Bluetooth range connect and play music through the TV, even while it is switched off. LG calls this Bluetooth Speaker Mode.') },
  { id: 'eArcSupport', section: 'sound', category: 'sound', key: 'eArcSupport', on: 'on', off: 'off',
    title: msg('srv.lgs.eArcSupport', 'eARC'),
    desc: msg('srv.lgs.eArcSupport.desc', 'Sends lossless and Dolby Atmos audio to a soundbar or receiver on the HDMI (eARC) input, where both support it.') },

  /*
   * Picture, as LG's Picture menu groups it on webOS 9.2. LG keeps these for
   * each input and picture mode, and its settings service reads and writes
   * those of the picture on screen when asked without a dimension, as LG's
   * own Settings app does. The names, ranges and help are that app's.
   */
  picture({ id: 'pictureMode', group: 'mode', key: 'pictureMode', type: 'choice', modified: false,
    choices: [], labelOf: function (v) { return names.pictureMode(v).display; },
    title: msg('srv.lgs.pictureMode', 'Picture mode'),
    desc: msg('srv.lgs.pictureMode.desc', 'The starting point for every setting below. The TV keeps a picture mode, and its adjustments, for each input.') }),
  picture({ id: 'filmMakerMode', group: 'mode', key: 'filmMakerMode', on: 'on', off: 'off', modified: false,
    title: msg('srv.lgs.filmMakerMode', 'FILMMAKER MODE auto start'),
    desc: msg('srv.lgs.filmMakerMode.desc', 'Switches to Filmmaker Mode by itself when a film or show asks for it.') }),

  picture({ id: 'backlight', group: 'brightness', key: 'backlight', type: 'number', min: 0, max: 100,
    title: msg('srv.lgs.backlight', 'Panel brightness'),
    desc: msg('srv.lgs.backlight.desc', 'How bright the screen is overall. LG calls this OLED Pixel Brightness, OLED Light on older OLEDs, and Backlight on an LCD.') }),
  picture({ id: 'contrast', group: 'brightness', key: 'contrast', type: 'number', min: 0, max: 100,
    title: msg('srv.lgs.contrast', 'Contrast'),
    desc: msg('srv.lgs.contrast.desc', 'The difference between bright and dark areas. Higher values brighten highlights.') }),
  picture({ id: 'brightness', group: 'brightness', key: 'brightness', type: 'number', min: 0, max: 100,
    title: msg('srv.lgs.brightness', 'Black level'),
    desc: msg('srv.lgs.brightness.desc', 'How bright the darkest parts of the picture are. Too high greys out black; too low hides shadow detail. LG calls this Screen Brightness on some TVs.') }),
  picture({ id: 'peakBrightness', group: 'brightness', key: 'peakBrightness', type: 'choice',
    choices: [lmh('off'), lmh('low'), lmh('medium'), lmh('high')],
    title: msg('srv.lgs.peakBrightness', 'Peak brightness'),
    desc: msg('srv.lgs.peakBrightness.desc', 'Lets small bright highlights, such as a lamp or the sun, go brighter than the rest of the picture.') }),
  picture({ id: 'dynamicContrast', group: 'brightness', key: 'dynamicContrast', type: 'choice',
    choices: [lmh('off'), lmh('low'), lmh('medium'), lmh('high')],
    title: msg('srv.lgs.dynamicContrast', 'Auto dynamic contrast'),
    desc: msg('srv.lgs.dynamicContrast.desc', 'Adjusts contrast scene by scene, from how bright each one is.') }),
  picture({ id: 'expressionEnhancer', group: 'brightness', key: 'expressionEnhancer', type: 'choice',
    choices: [lmh('off'),
      { value: 'detail', label: msg('srv.lgs.expressionEnhancer.detail', 'Detail') },
      { value: 'highlight', label: msg('srv.lgs.expressionEnhancer.highlight', 'Brightness') }],
    title: msg('srv.lgs.expressionEnhancer', 'Expression enhancer'),
    desc: msg('srv.lgs.expressionEnhancer.desc', 'Separates foreground from background in HDR video, favouring detail or brightness.') }),
  picture({ id: 'localDimming', group: 'brightness', key: 'localDimming', type: 'choice',
    choices: [lmh('off'), lmh('low'), lmh('medium'), lmh('high')],
    title: msg('srv.lgs.localDimming', 'Local dimming'),
    desc: msg('srv.lgs.localDimming.desc', 'Dims the backlight behind dark parts of the picture, so black looks blacker. LCD TVs only.') }),
  picture({ id: 'gamma', group: 'brightness', key: 'gamma', type: 'choice',
    choices: [
      { value: 'low', label: msg('srv.lgs.gamma.low', 'Low (1.9)') },
      { value: 'medium', label: msg('srv.lgs.gamma.medium', 'Medium (2.2)') },
      { value: 'high1', label: msg('srv.lgs.gamma.high1', 'High 1 (2.4)') },
      { value: 'high2', label: msg('srv.lgs.gamma.high2', 'High 2 (BT.1886)') }
    ],
    title: msg('srv.lgs.gamma', 'Gamma'),
    desc: msg('srv.lgs.gamma.desc', 'How quickly the picture brightens from black. A lower value brightens the mid-tones; a higher one darkens them.') }),
  // Kept for each HDMI input. An app's, and the tuner's, is one per colour
  // system, as an object, which this row leaves alone.
  picture({ id: 'blackLevel', group: 'brightness', key: 'blackLevel', type: 'choice',
    choices: [
      { value: 'auto', label: msg('srv.lgs.blackLevel.auto', 'Auto') },
      { value: 'low', label: msg('srv.lgs.blackLevel.low', 'Limited') },
      { value: 'high', label: msg('srv.lgs.blackLevel.high', 'Full') }
    ],
    title: msg('srv.lgs.blackLevel', 'Video range'),
    desc: msg('srv.lgs.blackLevel.desc', 'Match it to the range the device on this input sends. A mismatch crushes shadows or turns black grey.') }),
  picture({ id: 'hdrDynamicToneMapping', group: 'brightness', key: 'hdrDynamicToneMapping', type: 'choice',
    choices: [
      { value: 'on', label: msg('srv.lgs.dtm.on', 'On') },
      { value: 'off', label: msg('srv.lgs.dtm.off', 'Off') },
      { value: 'HGIG', label: 'HGIG' }
    ],
    title: msg('srv.lgs.hdrDynamicToneMapping', 'Dynamic tone mapping'),
    desc: msg('srv.lgs.hdrDynamicToneMapping.desc', 'Adjusts HDR video scene by scene to suit the panel. HGIG leaves it to a console that supports it.') }),
  // Screen Off is never offered: it blanks the screen. On a European G3
  // (OLED55G36LA, webOS 9.2) any step but Auto raised LG's "may increase energy
  // consumption" prompt on the TV; the value held while it waited, OK kept
  // it and Cancel set Auto.
  picture({ id: 'energySaving', group: 'brightness', key: 'energySaving', type: 'choice', modified: false,
    also: { energySavingModified: 'true' }, exclude: ['screen_off'],
    choices: [
      { value: 'auto', label: msg('srv.lgs.energySaving.auto', 'Auto') },
      { value: 'off', label: msg('srv.lgs.energySaving.off', 'Off') },
      { value: 'min', label: msg('srv.lgs.energySaving.min', 'Minimum') },
      { value: 'med', label: msg('srv.lgs.energySaving.med', 'Medium') },
      { value: 'max', label: msg('srv.lgs.energySaving.max', 'Maximum') }
    ],
    title: msg('srv.lgs.energySaving', 'Energy saving step'),
    desc: msg('srv.lgs.energySaving.desc', 'Dims the screen to save power. Off leaves panel brightness as set. Some TVs, such as those sold in Europe, ask on screen to confirm any step but Auto, and go back to Auto if it is cancelled.') }),

  picture({ id: 'color', group: 'colour', key: 'color', type: 'number', min: 0, max: 100, track: 'saturation',
    title: msg('srv.lgs.color', 'Colour depth'),
    desc: msg('srv.lgs.color.desc', 'How saturated colours are. Higher values are more vivid.') }),
  picture({ id: 'tint', group: 'colour', key: 'tint', type: 'number', min: -50, max: 50, track: 'tint',
    title: msg('srv.lgs.tint', 'Tint'),
    desc: msg('srv.lgs.tint.desc', 'The balance between red and green in the picture.') }),
  picture({ id: 'colorTemperature', group: 'colour', key: 'colorTemperature', type: 'number', min: -50, max: 50, track: 'temperature',
    title: msg('srv.lgs.colorTemperature', 'Colour temperature'),
    desc: msg('srv.lgs.colorTemperature.desc', 'From warm, which is yellower, to cool, which is bluer. Filmmaker Mode starts at Warm 50.') }),
  // The same setting as a list, on TVs older than the slider.
  picture({ id: 'whiteBalanceColorTemperature', group: 'colour', key: 'whiteBalanceColorTemperature', type: 'choice', unless: 'colorTemperature',
    choices: [
      { value: 'cool', label: msg('srv.lgs.wbTemperature.cool', 'Cool') },
      { value: 'medium', label: msg('srv.lgs.wbTemperature.medium', 'Medium') },
      { value: 'warm1', label: msg('srv.lgs.wbTemperature.warm1', 'Warm 1') },
      { value: 'warm2', label: msg('srv.lgs.wbTemperature.warm2', 'Warm 2') },
      { value: 'warm3', label: msg('srv.lgs.wbTemperature.warm3', 'Warm 3') }
    ],
    title: msg('srv.lgs.colorTemperature', 'Colour temperature'),
    desc: msg('srv.lgs.wbTemperature.desc', 'From cool, which is bluer, to warm, which is yellower.') }),
  picture({ id: 'colorGamut', group: 'colour', key: 'colorGamut', type: 'choice',
    choices: [
      { value: 'auto', label: msg('srv.lgs.colorGamut.auto', 'Auto detect') },
      { value: 'native', label: msg('srv.lgs.colorGamut.native', 'Native') },
      { value: 'normal', label: msg('srv.lgs.colorGamut.normal', 'Normal') },
      { value: 'wide', label: msg('srv.lgs.colorGamut.wide', 'Wide') },
      { value: 'extended', label: msg('srv.lgs.colorGamut.extended', 'Extended') },
      { value: 'dynamic', label: msg('srv.lgs.colorGamut.dynamic', 'Dynamic') },
      { value: 'srgb', label: 'sRGB' },
      { value: 'adobeRGB', label: 'Adobe RGB' }
    ],
    title: msg('srv.lgs.colorGamut', 'Colour gamut'),
    desc: msg('srv.lgs.colorGamut.desc', 'The range of colours shown. Auto detect follows the signal; Native and Dynamic stretch colours past it.') }),
  picture({ id: 'dynamicColor', group: 'colour', key: 'dynamicColor', type: 'choice',
    choices: [lmh('off'), lmh('low'), lmh('medium'), lmh('high'),
      { value: 'user', label: msg('srv.lgs.dynamicColor.user', 'User Selection') }],
    title: msg('srv.lgs.dynamicColor', 'Dynamic colour'),
    desc: msg('srv.lgs.dynamicColor.desc', 'Raises colour and saturation by itself to make the picture more vivid.') }),
  picture({ id: 'eyeComfortMode', group: 'colour', key: 'eyeComfortMode', on: 'on', off: 'off', modified: false,
    title: msg('srv.lgs.eyeComfortMode', 'Reduce blue light'),
    desc: msg('srv.lgs.eyeComfortMode.desc', 'Warms the picture to cut blue light.') }),
  // LG's Fine Tune, which it keeps as text.
  picture({ id: 'skinColor', group: 'colour', key: 'skinColor', type: 'number', min: -5, max: 5, store: 'string',
    title: msg('srv.lgs.skinColor', 'Skin colour'),
    desc: msg('srv.lgs.fineTune.desc', 'Fine-tunes one kind of colour without touching the rest.') }),
  picture({ id: 'skyColor', group: 'colour', key: 'skyColor', type: 'number', min: -5, max: 5, store: 'string',
    title: msg('srv.lgs.skyColor', 'Sky colour'),
    desc: msg('srv.lgs.fineTune.desc', 'Fine-tunes one kind of colour without touching the rest.') }),
  picture({ id: 'grassColor', group: 'colour', key: 'grassColor', type: 'number', min: -5, max: 5, store: 'string',
    title: msg('srv.lgs.grassColor', 'Grass colour'),
    desc: msg('srv.lgs.fineTune.desc', 'Fine-tunes one kind of colour without touching the rest.') }),

  // Two-point white balance, the gain for bright tones, the offset for dark,
  // each colour's pair side by side.
  picture({ id: 'wbRedGain', group: 'whiteBalance', key: 'whiteBalanceRedGain', type: 'number', min: -50, max: 50, track: 'red',
    title: msg('srv.lgs.wbRedGain', 'Red gain'), desc: msg('srv.lgs.wbGain.desc', 'This colour in the bright tones.') }),
  picture({ id: 'wbRedOffset', group: 'whiteBalance', key: 'whiteBalanceRedOffset', type: 'number', min: -50, max: 50, track: 'red',
    title: msg('srv.lgs.wbRedOffset', 'Red offset'), desc: msg('srv.lgs.wbOffset.desc', 'This colour in the dark tones.') }),
  picture({ id: 'wbGreenGain', group: 'whiteBalance', key: 'whiteBalanceGreenGain', type: 'number', min: -50, max: 50, track: 'green',
    title: msg('srv.lgs.wbGreenGain', 'Green gain'), desc: msg('srv.lgs.wbGain.desc', 'This colour in the bright tones.') }),
  picture({ id: 'wbGreenOffset', group: 'whiteBalance', key: 'whiteBalanceGreenOffset', type: 'number', min: -50, max: 50, track: 'green',
    title: msg('srv.lgs.wbGreenOffset', 'Green offset'), desc: msg('srv.lgs.wbOffset.desc', 'This colour in the dark tones.') }),
  picture({ id: 'wbBlueGain', group: 'whiteBalance', key: 'whiteBalanceBlueGain', type: 'number', min: -50, max: 50, track: 'blue',
    title: msg('srv.lgs.wbBlueGain', 'Blue gain'), desc: msg('srv.lgs.wbGain.desc', 'This colour in the bright tones.') }),
  picture({ id: 'wbBlueOffset', group: 'whiteBalance', key: 'whiteBalanceBlueOffset', type: 'number', min: -50, max: 50, track: 'blue',
    title: msg('srv.lgs.wbBlueOffset', 'Blue offset'), desc: msg('srv.lgs.wbOffset.desc', 'This colour in the dark tones.') }),

  // Colour management: saturation, hue and luminance for each of six colours.
  // cms names the colour and part the property, for the dashboard's grid.
  cms('red', 'Saturation', msg('srv.lgs.cms.redSaturation', 'Red saturation')),
  cms('red', 'Hue', msg('srv.lgs.cms.redHue', 'Red hue')),
  cms('red', 'Luminance', msg('srv.lgs.cms.redLuminance', 'Red luminance')),
  cms('green', 'Saturation', msg('srv.lgs.cms.greenSaturation', 'Green saturation')),
  cms('green', 'Hue', msg('srv.lgs.cms.greenHue', 'Green hue')),
  cms('green', 'Luminance', msg('srv.lgs.cms.greenLuminance', 'Green luminance')),
  cms('blue', 'Saturation', msg('srv.lgs.cms.blueSaturation', 'Blue saturation')),
  cms('blue', 'Hue', msg('srv.lgs.cms.blueHue', 'Blue hue')),
  cms('blue', 'Luminance', msg('srv.lgs.cms.blueLuminance', 'Blue luminance')),
  cms('cyan', 'Saturation', msg('srv.lgs.cms.cyanSaturation', 'Cyan saturation')),
  cms('cyan', 'Hue', msg('srv.lgs.cms.cyanHue', 'Cyan hue')),
  cms('cyan', 'Luminance', msg('srv.lgs.cms.cyanLuminance', 'Cyan luminance')),
  cms('magenta', 'Saturation', msg('srv.lgs.cms.magentaSaturation', 'Magenta saturation')),
  cms('magenta', 'Hue', msg('srv.lgs.cms.magentaHue', 'Magenta hue')),
  cms('magenta', 'Luminance', msg('srv.lgs.cms.magentaLuminance', 'Magenta luminance')),
  cms('yellow', 'Saturation', msg('srv.lgs.cms.yellowSaturation', 'Yellow saturation')),
  cms('yellow', 'Hue', msg('srv.lgs.cms.yellowHue', 'Yellow hue')),
  cms('yellow', 'Luminance', msg('srv.lgs.cms.yellowLuminance', 'Yellow luminance')),

  picture({ id: 'sharpness', group: 'clarity', key: 'sharpness', type: 'number', min: 0, max: 50,
    title: msg('srv.lgs.sharpness', 'Sharpness'),
    desc: msg('srv.lgs.sharpness.desc', 'Sharpens edges. Above 0 it can add outlines that are not in the source.') }),
  picture({ id: 'superResolution', group: 'clarity', key: 'superResolution', type: 'choice',
    choices: [lmh('off'), lmh('low'), lmh('medium'), lmh('high')],
    title: msg('srv.lgs.superResolution', 'Super resolution'),
    desc: msg('srv.lgs.superResolution.desc', 'Sharpens blurred and low-resolution parts of the picture.') }),
  picture({ id: 'noiseReduction', group: 'clarity', key: 'noiseReduction', type: 'choice',
    choices: [lmh('off'), lmh('low'), lmh('medium'), lmh('high'), lmh('auto')],
    title: msg('srv.lgs.noiseReduction', 'Noise reduction'),
    desc: msg('srv.lgs.noiseReduction.desc', 'Smooths out grain and stray pixels. It can soften fine detail and film grain too.') }),
  picture({ id: 'mpegNoiseReduction', group: 'clarity', key: 'mpegNoiseReduction', type: 'choice',
    choices: [lmh('off'), lmh('low'), lmh('medium'), lmh('high'), lmh('auto')],
    title: msg('srv.lgs.mpegNoiseReduction', 'MPEG noise reduction'),
    desc: msg('srv.lgs.mpegNoiseReduction.desc', 'Smooths the blocks and halos that compression leaves in streamed and recorded video.') }),
  picture({ id: 'smoothGradation', group: 'clarity', key: 'smoothGradation', type: 'choice',
    choices: [lmh('off'), lmh('low'), lmh('medium'), lmh('high')],
    title: msg('srv.lgs.smoothGradation', 'Smooth gradation'),
    desc: msg('srv.lgs.smoothGradation.desc', 'Smooths visible bands in gradients, such as a sky.') }),
  picture({ id: 'edgeEnhancer', group: 'clarity', key: 'edgeEnhancer', on: 'on', off: 'off',
    title: msg('srv.lgs.edgeEnhancer', 'Edge enhancer'),
    desc: msg('srv.lgs.edgeEnhancer.desc', 'Makes edges thinner and clearer.') }),
  picture({ id: 'dolbyPrecisionDetail', group: 'clarity', key: 'dolbyPrecisionDetail', on: 'on', off: 'off',
    title: msg('srv.lgs.dolbyPrecisionDetail', 'Precision Detail'),
    desc: msg('srv.lgs.dolbyPrecisionDetail.desc', 'Dolby Vision\'s own sharpening of fine texture, for Dolby Vision video only.') }),

  picture({ id: 'truMotionMode', perApp: true, group: 'motion', key: 'truMotionMode', type: 'choice',
    choices: [
      { value: 'off', label: msg('srv.lgs.truMotion.off', 'Off') },
      { value: 'cinemaClear', label: msg('srv.lgs.truMotion.cinemaClear', 'Cinematic Movement') },
      { value: 'natural', label: msg('srv.lgs.truMotion.natural', 'Natural') },
      { value: 'smooth', label: msg('srv.lgs.truMotion.smooth', 'Smooth Movement') },
      { value: 'clear', label: msg('srv.lgs.truMotion.clear', 'Clear') },
      { value: 'user', label: msg('srv.lgs.truMotion.user', 'User Selection') }
    ],
    title: msg('srv.lgs.truMotionMode', 'TruMotion'),
    desc: msg('srv.lgs.truMotionMode.desc', 'Adds frames between the source\'s own to smooth motion. Off keeps films as they were shot.') }),
  picture({ id: 'truMotionJudder', group: 'motion', key: 'truMotionJudder', type: 'number', min: 0, max: 10,
    title: msg('srv.lgs.truMotionJudder', 'De-judder'),
    desc: msg('srv.lgs.truMotionJudder.desc', 'How much TruMotion smooths stutter in slow pans. Used when TruMotion is User Selection.') }),
  picture({ id: 'truMotionBlur', group: 'motion', key: 'truMotionBlur', type: 'number', min: 0, max: 10,
    title: msg('srv.lgs.truMotionBlur', 'De-blur'),
    desc: msg('srv.lgs.truMotionBlur.desc', 'How much TruMotion clears blur from fast motion. Used when TruMotion is User Selection.') }),
  picture({ id: 'realCinema', group: 'motion', key: 'realCinema', on: 'on', off: 'off',
    title: msg('srv.lgs.realCinema', 'Real Cinema'),
    desc: msg('srv.lgs.realCinema.desc', 'Shows 24 fps films at a multiple of their own frame rate, so pans move as in a cinema.') }),
  picture({ id: 'motionProOLED', group: 'motion', key: 'motionProOLED', type: 'choice',
    choices: [lmh('off'), lmh('low'), lmh('medium'), lmh('high'), lmh('auto')],
    title: msg('srv.lgs.motionProOLED', 'OLED Motion'),
    desc: msg('srv.lgs.motionProOLED.desc', 'Inserts black frames to make motion clearer. It dims the picture and can flicker.') }),
  picture({ id: 'motionPro', group: 'motion', key: 'motionPro', on: 'on', off: 'off',
    title: msg('srv.lgs.motionPro', 'Motion Pro'),
    desc: msg('srv.lgs.motionPro.desc', 'Shows black between frames to make motion clearer. It dims the picture and can flicker.') }),

  /*
   * Aspect ratio is kept in a category of its own, for each app (an HDMI
   * input is an app here too). perApp: LG's own Settings app reads these, and
   * TruMotion, with the app on screen as app_id and writes them with
   * current_app; asked without, a G3 on webOS 9.2 answered only
   * arcMenuBySystem.
   */
  picture({ id: 'arcPerApp', perApp: true, group: 'aspect', category: 'aspectRatio', key: 'arcPerApp', type: 'choice', modified: false,
    choices: [
      { value: '16x9', label: '16:9' },
      { value: 'original', label: msg('srv.lgs.aspectRatio.original', 'Original') },
      { value: 'full_wide', label: msg('srv.lgs.aspectRatio.fullWide', 'Full Wide') },
      { value: '4x3', label: '4:3' },
      { value: '14x9', label: '14:9' },
      { value: '21x9', label: '21:9' },
      { value: '32x9', label: msg('srv.lgs.aspectRatio.32x9', 'Wide View (32:9)') },
      { value: '32x12', label: msg('srv.lgs.aspectRatio.32x12', 'Cinema View (32:12)') },
      { value: 'vertZoom', label: msg('srv.lgs.aspectRatio.vertZoom', 'Vertical Zoom') },
      { value: 'allDirZoom', label: msg('srv.lgs.aspectRatio.allDirZoom', '4-Way Zoom') },
      { value: 'zoom', label: msg('srv.lgs.aspectRatio.zoom', 'Zoom') },
      { value: 'cinema_zoom', label: msg('srv.lgs.aspectRatio.cinemaZoom', 'Cinema Zoom') }
    ],
    title: msg('srv.lgs.aspectRatio', 'Aspect ratio'),
    desc: msg('srv.lgs.aspectRatio.desc', 'How the picture fills the screen. Original shows it as the source sends it.') }),
  picture({ id: 'justScan', perApp: true, group: 'aspect', category: 'aspectRatio', key: 'justScan', type: 'choice', modified: false,
    choices: [lmh('auto'), { value: 'on', label: msg('srv.lgs.justScan.on', 'On') }, lmh('off')],
    title: msg('srv.lgs.justScan', 'Just Scan'),
    desc: msg('srv.lgs.justScan.desc', 'Shows every pixel the source sends, without cropping the edges. Turn it off if a line shows at the edge of the screen.') }),

  // HDMI inputs. Deep Colour on a C2 is one setting, for the input on screen.
  { id: 'deepColor', section: 'hdmi', column: 'deepColor', greyable: true, category: 'other', key: 'uhdDeepColor', type: 'choice',
    choices: [
      { value: 'off', label: msg('srv.lgs.deepColor.off', 'Off') },
      { value: 'on', label: msg('srv.lgs.deepColor.on', 'On') },
      { value: '4k', label: '4K' },
      { value: '8k', label: '8K' },
      { value: 'auto', label: msg('srv.lgs.deepColor.auto', 'Auto') }
    ],
    title: msg('srv.lgs.deepColor', 'HDMI Deep Colour'),
    desc: msg('srv.lgs.deepColor.desc', 'For the input on screen. Lets it take 4K HDR and high frame rates. The picture can drop out for a moment while the TV and the device agree the change, and turning it off also turns off Game Optimizer for that input.') },
  { id: 'deepColorHDMI1', section: 'hdmi', port: 1, column: 'deepColor', greyable: true, category: 'other', key: 'uhdDeepColorHDMI1', on: 'on', off: 'off', unless: 'uhdDeepColor',
    title: msg('srv.lgs.deepColorHdmi1', 'HDMI 1 Deep Colour'),
    desc: msg('srv.lgs.deepColorHdmi.desc', 'Lets the input take 4K HDR and high frame rates. The picture can drop out for a moment while the TV and the device agree the change.') },
  { id: 'deepColorHDMI2', section: 'hdmi', port: 2, column: 'deepColor', greyable: true, category: 'other', key: 'uhdDeepColorHDMI2', on: 'on', off: 'off', unless: 'uhdDeepColor',
    title: msg('srv.lgs.deepColorHdmi2', 'HDMI 2 Deep Colour'),
    desc: msg('srv.lgs.deepColorHdmi.desc', 'Lets the input take 4K HDR and high frame rates. The picture can drop out for a moment while the TV and the device agree the change.') },
  { id: 'deepColorHDMI3', section: 'hdmi', port: 3, column: 'deepColor', greyable: true, category: 'other', key: 'uhdDeepColorHDMI3', on: 'on', off: 'off', unless: 'uhdDeepColor',
    title: msg('srv.lgs.deepColorHdmi3', 'HDMI 3 Deep Colour'),
    desc: msg('srv.lgs.deepColorHdmi.desc', 'Lets the input take 4K HDR and high frame rates. The picture can drop out for a moment while the TV and the device agree the change.') },
  { id: 'deepColorHDMI4', section: 'hdmi', port: 4, column: 'deepColor', greyable: true, category: 'other', key: 'uhdDeepColorHDMI4', on: 'on', off: 'off', unless: 'uhdDeepColor',
    title: msg('srv.lgs.deepColorHdmi4', 'HDMI 4 Deep Colour'),
    desc: msg('srv.lgs.deepColorHdmi.desc', 'Lets the input take 4K HDR and high frame rates. The picture can drop out for a moment while the TV and the device agree the change.') },
  { id: 'audioFormatHDMI1', section: 'hdmi', port: 1, column: 'audioFormat', greyable: true, category: 'sound', key: 'inputAudioFormatHDMI1', type: 'choice',
    choices: [
      { value: 'bitstream', label: msg('srv.lgs.audioFormat.bitstream', 'Bitstream') },
      { value: 'pcm', label: msg('srv.lgs.audioFormat.pcm', 'PCM') }
    ],
    title: msg('srv.lgs.audioFormatHdmi1', 'HDMI 1 audio format'),
    desc: msg('srv.lgs.audioFormatHdmi.desc', 'What the TV asks the device on this input to send. Bitstream allows encoded audio; PCM requests decoded audio.') },
  { id: 'audioFormatHDMI2', section: 'hdmi', port: 2, column: 'audioFormat', greyable: true, category: 'sound', key: 'inputAudioFormatHDMI2', type: 'choice',
    choices: [
      { value: 'bitstream', label: msg('srv.lgs.audioFormat.bitstream', 'Bitstream') },
      { value: 'pcm', label: msg('srv.lgs.audioFormat.pcm', 'PCM') }
    ],
    title: msg('srv.lgs.audioFormatHdmi2', 'HDMI 2 audio format'),
    desc: msg('srv.lgs.audioFormatHdmi.desc', 'What the TV asks the device on this input to send. Bitstream allows encoded audio; PCM requests decoded audio.') },
  { id: 'audioFormatHDMI3', section: 'hdmi', port: 3, column: 'audioFormat', greyable: true, category: 'sound', key: 'inputAudioFormatHDMI3', type: 'choice',
    choices: [
      { value: 'bitstream', label: msg('srv.lgs.audioFormat.bitstream', 'Bitstream') },
      { value: 'pcm', label: msg('srv.lgs.audioFormat.pcm', 'PCM') }
    ],
    title: msg('srv.lgs.audioFormatHdmi3', 'HDMI 3 audio format'),
    desc: msg('srv.lgs.audioFormatHdmi.desc', 'What the TV asks the device on this input to send. Bitstream allows encoded audio; PCM requests decoded audio.') },
  { id: 'audioFormatHDMI4', section: 'hdmi', port: 4, column: 'audioFormat', greyable: true, category: 'sound', key: 'inputAudioFormatHDMI4', type: 'choice',
    choices: [
      { value: 'bitstream', label: msg('srv.lgs.audioFormat.bitstream', 'Bitstream') },
      { value: 'pcm', label: msg('srv.lgs.audioFormat.pcm', 'PCM') }
    ],
    title: msg('srv.lgs.audioFormatHdmi4', 'HDMI 4 audio format'),
    desc: msg('srv.lgs.audioFormatHdmi.desc', 'What the TV asks the device on this input to send. Bitstream allows encoded audio; PCM requests decoded audio.') },

  // HDMI-CEC, which LG calls SIMPLINK.
  { id: 'simplinkEnable', section: 'devices', category: 'other', key: 'simplinkEnable', on: 'on', off: 'off',
    title: msg('srv.lgs.simplinkEnable', 'SIMPLINK (HDMI-CEC)'),
    desc: msg('srv.lgs.simplinkEnable.desc', 'Lets the TV remote control devices connected over HDMI, such as a soundbar or console.') },
  { id: 'simplinkAutoPowerOn', section: 'devices', category: 'other', key: 'simplinkAutoPowerOn', on: 'on', off: 'off',
    title: msg('srv.lgs.simplinkAutoPowerOn', 'Auto power sync'),
    desc: msg('srv.lgs.simplinkAutoPowerOn.desc', 'Switching the TV off switches connected devices off, and switching a device on switches the TV on.') },
  // The password LG keeps beside this, password_ipcontrol, is never read.
  { id: 'ipControl', section: 'devices', category: 'option', key: 'enableIpControl', on: 'on', off: 'off',
    title: msg('srv.lgs.ipControl', 'IP control'),
    desc: msg('srv.lgs.ipControl.desc', 'Lets home automation systems control the TV over the network with LG\'s own protocol. Off unless something needs it.') }
];

var luna = null;
var lunaCached = null;
var clearLunaCache = null;

function init(opts) {
  luna = opts.luna;
  lunaCached = opts.lunaCached;
  clearLunaCache = opts.clearLunaCache;
}

function rowById(id) {
  for (var i = 0; i < ROWS.length; i++) if (ROWS[i].id === id) return ROWS[i];
  return null;
}

// desc: what the TV's settings service describes for the key, if it was asked.
function rowValue(r, v, desc) {
  var out = { id: r.id, section: r.section, type: r.type || 'switch', title: r.title, desc: r.desc };
  if (r.port) out.port = r.port;
  if (r.column) out.column = r.column;
  if (r.group) out.group = r.group;
  if (r.cms) { out.cms = r.cms; out.part = r.part; }
  if (r.track) out.track = r.track;
  if (r.greyable && desc && desc.active === false) out.active = false;
  if (out.type === 'switch') out.on = v === r.on;
  // A number can come back as text even where LG's menu writes numbers:
  // backlight read "80" on a G3 after a write of "80" (the Control tab's).
  else out.value = out.type === 'number' ? Number(v) : v;
  if (r.choices) {
    out.choices = choicesFor(r, desc);
    // A value set outside this list, such as another output from LG's menu,
    // is shown by its own name rather than as the first choice.
    var known = false;
    for (var k = 0; k < out.choices.length; k++) if (out.choices[k].value === v) known = true;
    if (!known) out.choices = out.choices.concat([{ value: v, label: labelFor(r, v) }]);
  }
  if (out.type === 'number') {
    out.min = desc && typeof desc.min === 'number' ? desc.min : r.min;
    out.max = desc && typeof desc.max === 'number' ? desc.max : r.max;
  }
  return out;
}

/*
 * The values a choice takes on this TV. A picture row takes them all from the
 * TV, in its order, since models and webOS versions differ in what they offer
 * (a C2 has eight sound modes where a B8 has six); its own list only names
 * them, and is the fallback where the TV describes nothing. Other rows offer
 * those of their own list the TV shows. exclude: values never offered here.
 */
function choicesFor(r, desc) {
  var shown = desc && desc.arrayExt;
  if (!shown) return r.choices;
  var visible = shown.filter(function (c) {
    return c.visible !== false && c.active !== false && !(r.exclude && r.exclude.indexOf(c.value) !== -1);
  });
  if (r.section === 'picture') {
    return visible.map(function (c) { return { value: c.value, label: labelFor(r, c.value) }; });
  }
  return r.choices.filter(function (c) {
    for (var i = 0; i < visible.length; i++) if (visible[i].value === c.value) return true;
    return false;
  });
}

// A value's name: the row's, or the picture mode's. A picture value the row
// does not name takes LG's level names, or is spelled out (cinemaClear reads
// "Cinema clear"); any other is shown as the TV gives it.
function labelFor(r, v) {
  if (r.labelOf) return r.labelOf(v);
  for (var i = 0; i < r.choices.length; i++) if (r.choices[i].value === v) return r.choices[i].label;
  if (r.section !== 'picture') return String(v);
  if (LEVELS.hasOwnProperty(v)) return LEVELS[v];
  var text = String(v).replace(/_/g, ' ').replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// What getSystemSettingDesc says of one key. webOS 9.2 gives a number's range
// as values.range and a choice's values as values.arrayExt; the plain min, max
// and array are read too, for firmware that gives those.
function describe(x) {
  var vs = x.values || {};
  var range = vs.range || vs;
  var list = vs.arrayExt || (Array.isArray(vs.array) ? vs.array.map(function (v) { return { value: v }; }) : null);
  var d = list ? { arrayExt: list } : { min: range.min, max: range.max };
  // LG greys out a setting it cannot change now, such as Deep Colour
  // while the TV is not on an HDMI input.
  d.active = !(x.ui && x.ui.active === false);
  d.visible = !(x.ui && x.ui.visible === false);
  return d;
}

// Where a row's value is kept: its category, or for a perApp row the
// category as LG keeps it for the app on screen.
function storeOf(r) { return r.perApp ? r.category + '@app' : r.category; }

// The app on screen, which perApp rows are read for. An HDMI input is an app
// too (com.webos.app.hdmi4).
function foregroundApp(ttl, cb) {
  lunaCached('com.webos.applicationManager/getForegroundAppInfo', {}, ttl, function (r) {
    cb(r && r.appId || null);
  });
}

// Every row in a section the TV has, with its value now, and the dimension LG
// reports for each category: the game input and genre the game rows belong to,
// and the input, picture mode and dynamic range the picture rows belong to.
// ttl: how long a reading may be reused, 30 seconds unless given.
function collect(section, cb, ttl) {
  if (!ttl) ttl = 30000;
  var sections = [].concat(section);
  var rows = ROWS.filter(function (r) { return sections.indexOf(r.section) !== -1; });
  var stores = [];
  rows.forEach(function (r) { if (stores.indexOf(storeOf(r)) === -1) stores.push(storeOf(r)); });
  var values = {};
  var dims = {};
  var descs = {};
  var appId = null;
  var i = 0;
  if (rows.some(function (r) { return r.perApp; })) foregroundApp(ttl, function (id) { appId = id; next(); });
  else next();
  function next() {
    if (i >= stores.length) {
      var out = [];
      rows.forEach(function (r) {
        var store = values[storeOf(r)] || {};
        var v = store[r.key];
        // An object is a setting kept some other way than the row's, such as
        // an app's Video Range, which LG keeps for each colour system.
        if (v === undefined || v === null || typeof v === 'object') return;
        if (r.unless && store[r.unless] !== undefined) return;
        var desc = descs[storeOf(r)] && descs[storeOf(r)][r.key];
        if (r.hideable && desc && !desc.visible) return;
        // A key the TV keeps but does not describe, where it describes the
        // others, is not one its menu offers: a G3 (webOS 9.2) refused a write
        // to edgeEnhancer with "ERROR!! sending a request to DB".
        if (r.hideable && !desc && descs[storeOf(r)] && Object.keys(descs[storeOf(r)]).length) return;
        out.push(rowValue(r, v, desc));
      });
      if (sections.indexOf('picture') !== -1) colourManagementState(out, dims.picture);
      // A TV that describes none of its picture settings (an older webOS, or a
      // description that failed) gets no Picture rows: without LG's own
      // choices and ranges, the tab could offer what its menu does not.
      if (sections.indexOf('picture') !== -1 && !(descs.picture && Object.keys(descs.picture).length)) {
        out = out.filter(function (x) { return x.section !== 'picture'; });
      }
      return cb({ ok: true, rows: out, dimensions: dims });
    }
    var store = stores[i++];
    var own = rows.filter(function (r) { return storeOf(r) === store; });
    var cat = own[0].category;
    var perApp = own[0].perApp;
    if (perApp && !appId) return next();
    // LG's own Settings app asks for a perApp key by name, with the app; a
    // key the TV lacks fails the call but leaves the others in its answer.
    var ask = perApp ? { category: cat, app_id: appId, keys: own.map(function (r) { return r.key; }) } : { category: cat };
    lunaCached('com.webos.service.settings/getSystemSettings', ask, ttl, function (res) {
      values[store] = (res && (perApp || res.returnValue !== false) && res.settings) || {};
      if (res && res.dimension && !perApp) dims[cat] = res.dimension;
      var keys = own.map(function (r) { return r.key; })
                    .filter(function (k) { return values[store][k] !== undefined; });
      if (!keys.length) return next();
      if (cat !== 'sound' || perApp) return describeStore(store, cat, perApp, keys);
      // The sound category read whole can lag a change: a G5 on webOS 10.3
      // reported Digital Sound Output as auto there and passThrough when the
      // key was named. Only keys the whole read returned are named, so no TV
      // is asked for one it lacks.
      lunaCached('com.webos.service.settings/getSystemSettings', { category: cat, keys: keys }, ttl, function (now) {
        var current = (now && now.returnValue !== false && now.settings) || {};
        keys.forEach(function (k) { if (current[k] !== undefined) values[store][k] = current[k]; });
        describeStore(store, cat, perApp, keys);
      });
    });
  }

  // The values a choice or number may take on this TV, and whether it can
  // be changed now, which follows the input on screen.
  function describeStore(store, cat, perApp, keys) {
    var describeAsk = { category: cat, keys: keys };
    if (perApp) describeAsk.app_id = appId;
    lunaCached('com.webos.service.settings/getSystemSettingDesc', describeAsk, ttl, function (d) {
      descs[store] = {};
      ((d && d.results) || []).forEach(function (x) { descs[store][x.key] = describe(x); });
      next();
    });
  }
}

/*
 * Colour management as LG's menu has it. Where Dynamic colour offers User
 * Selection, LG names it Colour adjustment and its per-colour sliders apply only
 * there (a C2, webOS 9.2.2), so it heads them, and they are greyed out
 * otherwise. Game mode ignores them though the TV reports them active: on a C2
 * they changed nothing in Game and did in ISF Expert.
 */
function colourManagementState(rows, dimension) {
  var gate = rows.filter(function (x) { return x.id === 'dynamicColor'; })[0];
  var gated = !!(gate && gate.choices && gate.choices.some(function (c) { return c.value === 'user'; }));
  if (gated) {
    gate.group = 'cms';
    gate.title = msg('srv.lgs.colourAdjustment', 'Colour adjustment');
    gate.desc = msg('srv.lgs.colourAdjustment.desc', 'User Selection turns on the colour adjustments below.');
  }
  var game = /game/i.test(String(dimension && dimension.pictureMode || ''));
  rows.forEach(function (x) {
    if (x.group !== 'cms' || x === gate || x.active === false) return;
    if (game) { x.active = false; x.inactive = 'game'; }
    else if (gated && gate && gate.value !== 'user') { x.active = false; x.inactive = 'colourAdjustment'; }
  });
}

// value: true or false for a switch, one of the values the TV offers for a
// choice, a whole number in the TV's range for a number. Each is checked
// against what the TV describes now, or the row's own where it describes none.
function set(id, value, cb) {
  var r = rowById(id);
  if (!r) return cb({ ok: false, error: msg('srv.lgsettings.unknown', 'Unknown setting') });
  var inactive = { ok: false, error: r.section === 'picture'
    ? msg('lgs.pictureInactive', 'Not available in the current picture mode, or for what is on screen.')
    : msg('lgs.inactive', 'Not available with the TV’s current input or sound output.') };
  if (!r.perApp) return check({ category: r.category, keys: [r.key] });
  foregroundApp(0, function (appId) {
    if (!appId) return cb(inactive);
    check({ category: r.category, keys: [r.key], app_id: appId });
  });

  function check(ask) {
    luna('com.webos.service.settings/getSystemSettingDesc', ask, function (d) {
      var x = d && d.results && d.results[0];
      var desc = x && x.key === r.key ? describe(x) : null;
      if (r.hideable && desc && !desc.visible) return cb(inactive);
      var stored = valueToStore(r, value, desc);
      if (stored === undefined) return cb({ ok: false, error: msg('srv.lgsettings.badValue', 'That value is not one this setting takes') });
      var settings = {};
      settings[r.key] = stored;
      for (var k in r.also) settings[k] = r.also[k];
      /*
       * LG's menu greys out an HDMI input's settings while another input is on
       * screen, but its settings service stores a write regardless (a C2 did,
       * on webOS 9.2). So for those the greying is checked here, fresh, and
       * honoured.
       */
      if (r.greyable && desc && desc.active === false) return cb(inactive);
      if (r.section !== 'picture') return write(settings);
      luna('com.webos.service.settings/getSystemSettings', { category: 'picture', keys: ['pictureMode', 'pictureSettingModified'] }, function (cur) {
        var now = cur && cur.settings || {};
        // As the Control tab's picture mode: Gallery holds the picture as it is.
        if (cur && cur.dimension && cur.dimension.input === 'gallery') {
          return cb({ ok: false, error: msg('srv.lgs.galleryLocked', 'The picture is locked while Gallery is on screen.') });
        }
        var marked = now.pictureSettingModified;
        if (r.modified && now.pictureMode && marked && typeof marked === 'object' && marked[now.pictureMode] !== true) {
          var copy = {};
          for (var m in marked) copy[m] = marked[m];
          copy[now.pictureMode] = true;
          settings.pictureSettingModified = copy;
        }
        write(settings);
      });
    });
  }

  // A perApp row is written as LG's app writes it, for the app on screen.
  function write(settings) {
    var payload = { category: r.category, settings: settings };
    if (r.perApp) payload.current_app = true;
    luna('com.webos.service.settings/setSystemSettings', payload, function (res) {
      clearLunaCache();
      if (res && res.returnValue) return cb({ ok: true });
      cb({ ok: false, error: msg('srv.lgs.refused', 'The TV did not take the change.') });
    });
  }
}

// The value LG stores for a row's value, or undefined if the TV does not take it.
function valueToStore(r, value, desc) {
  var type = r.type || 'switch';
  var stored;
  if (type === 'switch') stored = value === true ? r.on : r.off;
  else if (type === 'choice') {
    choicesFor(r, desc).forEach(function (c) { if (c.value === value) stored = value; });
  } else {
    var min = desc && typeof desc.min === 'number' ? desc.min : r.min;
    var max = desc && typeof desc.max === 'number' ? desc.max : r.max;
    if (typeof value === 'number' && value % 1 === 0 && value >= min && value <= max) stored = value;
  }
  return stored !== undefined && r.store === 'string' ? String(stored) : stored;
}

module.exports = {
  init: init,
  collect: collect,
  set: set,
  ROWS: ROWS
};
