/**
 * test/test-panel-silicon.js - Unit tests for OLED cell and TCON firmware reading
 */

var assert = require('assert');
var mockEnv = require('./mocks/mock-env').createMockEnv();
mockEnv.install();

var telemetry = require('../server/lib/telemetry');
var oled = require('../server/lib/oled');

console.log('Running test-panel-silicon.js ...');

function baseMockLuna(extra) {
  return function (uri, params, cb) {
    if (uri === 'com.webos.service.tv.systemproperty/getSystemProperties') {
      return cb({ returnValue: true, modelName: 'LG TV', sdkVersion: '9.2.0' });
    }
    if (extra && extra(uri, params, cb)) return;
    cb({ returnValue: true });
  };
}

// 1. LCD TV: detectHardwareInfo does not query or set panel silicon
(function testLcdPanelSiliconSuppressed() {
  telemetry.HARDWARE_INFO.cell = null;
  telemetry.HARDWARE_INFO.tconFirmware = null;
  telemetry.HARDWARE_INFO.tconModule = null;

  var cellQueried = false;
  var mockLuna = baseMockLuna(function (uri, params, cb) {
    if (uri === 'com.webos.service.panelcontroller/getOledCellInfo') {
      cellQueried = true;
      cb({ returnValue: true, cellInfo: '00/00/0/00' });
      return true;
    }
    if (uri === 'com.webos.service.panelcontroller/getOledTconInfo') {
      cb({ returnValue: true, tconParamForInstart: { tconFpgaFirmwareVer: 'N/A' } });
      return true;
    }
  });

  telemetry.init({
    luna: mockLuna,
    oled: {
      detectOled: function (cb) { cb(false); },
      getIsOled: function () { return false; }
    },
    config: {}
  });

  telemetry.detectDeviceInfo(function () {
    assert.strictEqual(cellQueried, false, 'LCD TV must not query OLED cell info');
    assert.strictEqual(telemetry.HARDWARE_INFO.cell, null);
    assert.strictEqual(telemetry.HARDWARE_INFO.tconFirmware, null);
    console.log('  ✓ LCD TV does not query or set OLED panel silicon info');
    testDummyCellIgnored();
  });
})();

// 2. Dummy cell (00/00/0/00) is ignored even if query runs
function testDummyCellIgnored() {
  telemetry.HARDWARE_INFO.cell = null;
  telemetry.HARDWARE_INFO.tconFirmware = null;
  telemetry.HARDWARE_INFO.tconModule = null;

  var mockLuna = baseMockLuna(function (uri, params, cb) {
    if (uri === 'com.webos.service.panelcontroller/getOledCellInfo') {
      cb({ returnValue: true, cellInfo: '00/00/0/00' });
      return true;
    }
    if (uri === 'com.webos.service.panelcontroller/getOledTconInfo') {
      cb({ returnValue: true, tconParamForInstart: { tconFpgaFirmwareVer: 'N/A' } });
      return true;
    }
  });

  telemetry.init({
    luna: mockLuna,
    oled: {
      detectOled: function (cb) { cb(true); },
      getIsOled: function () { return true; }
    },
    config: {}
  });

  telemetry.detectDeviceInfo(function () {
    assert.strictEqual(telemetry.HARDWARE_INFO.cell, null, 'Dummy 00/00/0/00 cell must be ignored');
    assert.strictEqual(telemetry.HARDWARE_INFO.tconFirmware, null, 'TCON without valid cell must be ignored');
    console.log('  ✓ Dummy 00/00/0/00 OLED cell reading is ignored');
    testRealOledCellPopulated();
  });
}

// 3. Real OLED cell reading is populated
function testRealOledCellPopulated() {
  telemetry.HARDWARE_INFO.cell = null;
  telemetry.HARDWARE_INFO.tconFirmware = null;
  telemetry.HARDWARE_INFO.tconModule = null;

  var mockLuna = baseMockLuna(function (uri, params, cb) {
    if (uri === 'com.webos.service.panelcontroller/getOledCellInfo') {
      cb({ returnValue: true, cellInfo: '08/00/1/03' });
      return true;
    }
    if (uri === 'com.webos.service.panelcontroller/getOledTconInfo') {
      cb({ returnValue: true, tconParamForInstart: { tconFpgaFirmwareVer: 'C.0A.00.40.0', tconModuleInfo: '00000000000000' } });
      return true;
    }
  });

  telemetry.init({
    luna: mockLuna,
    oled: {
      detectOled: function (cb) { cb(true); },
      getIsOled: function () { return true; }
    },
    config: {}
  });

  telemetry.detectDeviceInfo(function () {
    assert.strictEqual(telemetry.HARDWARE_INFO.cell, '08/00/1/03');
    assert.strictEqual(telemetry.HARDWARE_INFO.tconFirmware, 'C.0A.00.40.0');
    assert.strictEqual(telemetry.HARDWARE_INFO.tconModule, '00000000000000');
    console.log('  ✓ Genuine OLED cell info is parsed and populated');
    testOledModulePanelControllerInfo();
  });
}

// 4. oled.readPanelControllerInfo suppresses on non-OLED or dummy cell
function testOledModulePanelControllerInfo() {
  oled.init({
    config: { panel: 'lcd' },
    luna: function (uri, params, cb) {
      if (uri === 'com.webos.service.panelcontroller/getOledCellInfo') {
        return cb({ returnValue: true, cellInfo: '00/00/0/00' });
      }
      cb({ returnValue: true });
    }
  });

  oled.detectOled(function (isOled) {
    assert.strictEqual(isOled, false);
    oled.readPanelControllerInfo(function (res) {
      assert.strictEqual(res, null, 'readPanelControllerInfo must be null on non-OLED');
      console.log('  ✓ oled.readPanelControllerInfo returns null for non-OLED TV');
      console.log('ALL test-panel-silicon.js assertions passed!\n');
      mockEnv.restore();
    });
  });
}
