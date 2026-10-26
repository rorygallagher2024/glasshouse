# Privacy and data collection

The **Privacy** tab (`/?tab=privacy`) surfaces the TV's telemetry, advertising, and content-recognition settings in one place — most of which are buried across multiple submenus in LG's interface.

<div class="grid cards" markdown>

-   **One-click privacy summary**

    ---

    Opens with an at-a-glance status of screen recognition, ad tracking, and usage reporting, plus a single button to switch all of them off while leaving voice recognition untouched.

-   **Screen recognition (ACR) & services**

    ---

    Reports whether LG's content-recognition engine is running and sampling frames, shows the physical microphone switch state (on models that have one, such as the C5), and provides switches for LG's background diagnostics uploaders. See [What LG's ACR does](../ACR.md).

-   **Data agreements**

    ---

    Lists every data collection agreement recorded on the TV, grouped by subject, with switches to withdraw consent (persisting across reboots). Accepting new terms is left to LG's own menus.

-   **Advertising ID & cookies**

    ---

    Displays the TV's advertising identifier, the **Limit ad tracking** toggle, and actions to reset the ID and clear stored ad cookies.

-   **On-screen ads & promotions**

    ---

    Individual switches for screen saver ads, Home screen sponsored tiles and recommendations, promotions shown while watching, and Smart Tips (each shown on TVs that support it).

-   **On-TV ad & telemetry blocker**

    ---

    Blackholes LG's tracking, ad, and Alphonso ACR endpoints directly on the TV by bind-mounting a blocklist over `/etc/hosts` on boot.

</div>

## On-TV ad & telemetry blocker

The built-in blocker runs directly on the TV without needing an external DNS sinkhole (such as Pi-hole), and automatically re-applies on boot.

=== "Ads & telemetry tier"

    Blocks LG's advertising, diagnostics, customer-data, and Alphonso screen-recognition servers while leaving LG's core service platform reachable (so the Content Store, app updates, and LG ThinQ continue to work).

=== "Everything tier"

    Adds the hosts that carry LG's platform services:

    * **What stops working:** The LG ThinQ phone app, the Content Store, firmware updates, LG Channels, and LG's search, so [Glasshouse Home's search](home.md#search) is hidden while it blocks it. (To block only firmware updates while keeping platform services, use **Block TV software updates** on the [Advanced tab](advanced.md) instead.)
    * **Clock sync after a power cut:** After a cold boot, the blocker waits for the TV to set its clock from LG's time servers before blocking them. If the TV's date is still wrong and apps fail with certificate errors, set the time manually under **Settings › General › System › Time & Date** (with **Set Automatically** off).
    * **Switching back:** After switching away from **everything**, LG's built-in apps (such as Content Store or LG Channels) may take about a minute to reconnect while their browser engine's DNS cache expires.

=== "Custom hosts file"

    Under **Custom ad blocking** at the bottom of the Privacy tab, a custom hosts file or plain domain list can be uploaded from the browser:

    * **Supported format:** Standard hosts lines (`0.0.0.0`, `127.0.0.1`, `::`, or `::1` followed by a hostname) or one bare domain per line (up to 10,000 domains and 1 MB; lines redirecting to other IPs are skipped).
    * **Combine or replace:** Choose **Your file and Glasshouse's list** to merge the custom list with the active tier, or **Only your file** to block strictly the uploaded domains.
    * **Quick troubleshooting:** Toggle **Block its names** off to test whether a custom domain is breaking an app without deleting the uploaded file.

## Full tab view

![Privacy tab: an overview of what is still on, then the ad and telemetry blocker, advertising identifier, the data collection agreements grouped by subject with toggles, what is running now, and custom ad blocking](../screenshots/privacy.png)

*Privacy controls, data agreements, advertising ID, LG telemetry blocking and custom ad blocking.*
