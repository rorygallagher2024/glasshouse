import QtQuick 2.4

// One slot with a default and one left blank, which is given no address.
Item {
    property int level: __TVWEB_LEVEL__
    property string powerUrl: "__TVWEB_HA_power__"
    property string spareUrl: "__TVWEB_HA_spare__"
}
