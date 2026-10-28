package sudoku.android

import sudoku.data.AppStorage
import sudoku.data.KeyValueStore
import java.io.File

/**
 * One file per key, `<key>.json` under [dir] (the app's private files
 * directory). Writes go to a temporary file that's then renamed over the
 * original, so a crash mid-write never leaves a torn file.
 */
class FileKeyValueStore(private val dir: File) : KeyValueStore {
    @Synchronized
    override fun get(key: String): String? = try {
        file(key).takeIf { it.exists() }?.readText()
    } catch (e: Exception) {
        null
    }

    @Synchronized
    override fun set(key: String, value: String?) {
        val file = file(key)
        if (value == null) {
            file.delete()
            return
        }
        dir.mkdirs()
        val tmp = File(dir, file.name + ".tmp")
        tmp.writeText(value)
        if (!tmp.renameTo(file)) {
            file.delete()
            check(tmp.renameTo(file)) { "couldn't write $file" }
        }
    }

    @Synchronized
    override fun update(key: String, change: (String?) -> String?) = set(key, change(get(key)))

    private fun file(key: String) = File(dir, "$key.json")
}

/** The app's storage in [dir]. The file names are those of earlier versions, so existing installs keep their data. */
fun AppStorage(dir: File): AppStorage = AppStorage(FileKeyValueStore(dir))
