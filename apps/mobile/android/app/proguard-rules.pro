# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# JNA loads the Rust engine by reflection and calls back through native stubs.
# R8 must keep every JNA class and every member of a class that extends JNA.
-dontwarn java.awt.*
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.* { public *; }

# The UniFFI bindings declare the FFI surface as a JNA Library. R8 must keep the
# generated names, because JNA looks them up by name.
-keep class uniffi.** { *; }

# DaakShareModule (modules/rn-share) calls DirectShareShortcuts.sync by name
# through reflection, because the class lives in the app module. R8 renames the
# method unless it is kept.
-keep class dev.darshit.daak.shortcuts.DirectShareShortcuts { *; }
