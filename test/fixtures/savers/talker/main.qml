import QtQuick 2.4
// "http://in-a-comment.example" is still a web address
Item {
  Audio { source: "x.wav" }
  Component.onCompleted: { var r = new XMLHttpRequest(); }
}
