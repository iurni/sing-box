fun main() {
    check(baiduVersionCode("Notes\n<!-- android-version-code: 1794475600 -->") == 1794475600)
    check(baiduVersionCode("<!-- android-version-code: 2147483647 -->") == Int.MAX_VALUE)
    for (body in listOf(null, "", "<!-- android-version-code: 0 -->",
        "<!-- android-version-code: -1 -->", "<!-- android-version-code: 2147483648 -->",
        "<!-- android-version-code: 1794475600 -->\n<!-- android-version-code: 1794475601 -->",
        "<!-- android-version-code: 1794475600 --> android-version-code: 2",
        "<!-- android-version-code: 1794475600 -->X<!-- android-version-code: broken -->",
        "android-version-code: 1794475600")) {
        check(baiduVersionCode(body) == null) { "Invalid release body accepted: $body" }
    }
    check(baiduReleaseVersion("v1.14.4-baidu.43191538916") == "1.14.4-baidu.43191538916")
    for (tag in listOf("v1.14.4", "v1.14.4-baidu.0", "v1.14.4-beta.1", "v1.14.04-baidu.2", "v1.14.4-baidu.2-extra")) {
        check(baiduReleaseVersion(tag) == null) { "Invalid release tag accepted: $tag" }
    }
    check(baiduVersionIsNewer("1.14.4-baidu.10", "1.14.4-baidu.9"))
    check(baiduVersionIsNewer("1.14.5-baidu.1", "1.14.4-baidu.999"))
    check(baiduVersionIsNewer("1.14.4-baidu.999999999999999999999", "1.14.4-baidu.9"))
    check(!baiduVersionIsNewer("1.14.3-baidu.999", "1.14.4-baidu.1"))
    check(!baiduVersionIsNewer("1.14.4-baidu.9", "1.14.4-baidu.9"))
    check(!baiduVersionIsNewer("1.14.4-baidu.10", "1.14.4"))
}
