using System;
using System.IO;

class WindowsFileLock {
    static void Main(string[] args) {
        using (var file = File.Open(args[0], FileMode.Open, FileAccess.Read, FileShare.Read)) {
            Console.WriteLine("locked");
            Console.Out.Flush();
            Console.ReadLine();
        }
    }
}
