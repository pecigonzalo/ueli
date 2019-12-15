import { executeCommandWithOutput } from "../../executors/command-executor";
import { ControlPanelItem } from "./control-panel-item";
import * as Powershell from "node-powershell";

export class ControlPanelItemsRetriever {
    public static async RetrieveControlPanelItems(alreadyKnownItems: ControlPanelItem[]): Promise<ControlPanelItem[]> {
        const controlPanelItemsJson = await this.executeCommandWithUtf8Output('powershell -Command "Get-ControlPanelItem | ConvertTo-Json"');
        const controlPanelItems: ControlPanelItem[] = JSON.parse(controlPanelItemsJson);

        const alreadyKnownItemsStillPresent = controlPanelItems.filter((item) => alreadyKnownItems.some((i) => i.Name === item.Name));
        const newControlPanelItems = controlPanelItems.filter((item) => !alreadyKnownItems.some((i) => i.Name === item.Name));

        const iconSize = 128;
        const getIconsCommand = `
$iconExtractorCode = '${this.iconExtractorCode}';
$iconExtractorType = Add-Type -TypeDefinition $iconExtractorCode -PassThru -ReferencedAssemblies 'System.Drawing.dll';
$ErrorActionPreference = "SilentlyContinue";

Get-Item -Path "Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ControlPanel\\NameSpace\\*" |
    Select-Object -ExpandProperty Name |
    ForEach-Object {
        if ($_.substring($_.lastindexof("\\") + 1) -match "{.+}") { return $Matches[0] }
        else { return $null }
    } |
    Where-Object { $_ -ne $null } |
    ForEach-Object {
        $defaultIconValue = Get-ItemPropertyValue -Path "Registry::HKEY_CLASSES_ROOT\\CLSID\\$_\\DefaultIcon" -Name "(default)";
        $defaultIconValueSplit = $defaultIconValue.Split(',');
        $iconPath = $defaultIconValueSplit[0];
        $iconIndex = if ($defaultIconValueSplit.Length -gt 1) { $defaultIconValueSplit[1] } else { $null };
        $iconBase64 = $iconExtractorType[0]::GetIconAsBase64($iconPath, ${iconSize}, $iconIndex);
        @{
            applicationName = Get-ItemPropertyValue -Path "Registry::HKEY_CLASSES_ROOT\\CLSID\\$_" -Name "System.ApplicationName";
            iconBase64 = $iconBase64;
        };
    } |
    ConvertTo-Json
        `;
        let controlPanelItemIcons: Array<{ applicationName: string, iconBase64: string }> = [];
        const shell = new Powershell({});
        try {
            await shell.addCommand(getIconsCommand);
            const controlPanelItemIconsJson = await shell.invoke();
            controlPanelItemIcons = JSON.parse(controlPanelItemIconsJson);
        } finally {
            await shell.dispose();
        }
        for (const icon of controlPanelItemIcons) {
            const item = newControlPanelItems.find((i) => i.CanonicalName === icon.applicationName);
            if (item != null && icon.iconBase64 != null) {
                item.IconBase64 = icon.iconBase64;
            }
        }
        return alreadyKnownItemsStillPresent.concat(newControlPanelItems);
    }

    private static readonly iconExtractorCode = `
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace IconExtractor
{
    public class IconExtractor
    {
        private const uint GroupIcon = 14;
        private const uint LoadLibraryAsDatafile = 0x00000002;

        private delegate bool EnumResNameDelegate(IntPtr hModule, IntPtr lpszType, IntPtr lpszName, IntPtr lParam);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr LoadLibraryEx(string lpFileName, IntPtr hFile, uint dwFlags);

        [DllImport("kernel32.dll", EntryPoint = "EnumResourceNamesW", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool EnumResourceNamesWithId(IntPtr hModule, uint lpszType, EnumResNameDelegate lpEnumFunc, IntPtr lParam);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool FreeLibrary(IntPtr hModule);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        static extern IntPtr LoadImage(IntPtr hinst, IntPtr lpszName, uint uType, int cxDesired, int cyDesired, uint fuLoad);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        static extern bool DestroyIcon(IntPtr handle);

        public static string GetIconAsBase64(string filePath, int iconSize, string iconIndex = null)
        {
            var iconPointer = GetIconPointer(filePath, iconSize, iconIndex);
            if (iconPointer != IntPtr.Zero)
            {
                var icon = Icon.FromHandle(iconPointer);
                var bitmap = icon.ToBitmap();
                DestroyIcon(iconPointer);
                using (var stream = new MemoryStream())
                {
                    bitmap.Save(stream, ImageFormat.Png);
                    var base64String = Convert.ToBase64String(stream.ToArray());
                    return base64String;
                }
            }
            return null;
        }

        private static IntPtr GetIconPointer(string filePath, int iconSize, string iconIndex = null)
        {
            var dataFilePointer = LoadLibraryEx(filePath, IntPtr.Zero, LoadLibraryAsDatafile);
            if (dataFilePointer == IntPtr.Zero)
                return IntPtr.Zero;
            var iconIndexPointer = iconIndex != null
                                        ? new IntPtr(Math.Abs(Convert.ToInt32(iconIndex)))
                                        : IntPtr.Zero;
            var iconPointer = LoadImage(dataFilePointer, iconIndexPointer, 1, iconSize, iconSize, 0);
            if (iconPointer == IntPtr.Zero)
            {
                EnumResourceNamesWithId(dataFilePointer, GroupIcon, (hModule, lpszType, lpszName, lParam) =>
                {
                    iconPointer = lpszName;
                    return false;
                }, IntPtr.Zero);
                iconPointer = LoadImage(dataFilePointer, iconPointer, 1, iconSize, iconSize, 0);
            }
            FreeLibrary(dataFilePointer);
            return iconPointer;
        }
    }
}
    `;

    private static executeCommandWithUtf8Output(command: string): Promise<string> {
        return executeCommandWithOutput(`cmd /c chcp 65001>nul && ${command}`);
    }
}
