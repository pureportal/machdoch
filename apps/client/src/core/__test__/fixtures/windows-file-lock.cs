using System;
using System.IO;

class WindowsFileLock {
    static void Main(string[] args) {
        var sharing = args[1] == "read" ? FileShare.Read : FileShare.None;
        using (var file = File.Open(args[0], FileMode.Open, FileAccess.Read, sharing)) {
            Console.WriteLine("locked");
            Console.Out.Flush();
            Console.ReadLine();
        }
    }
}
