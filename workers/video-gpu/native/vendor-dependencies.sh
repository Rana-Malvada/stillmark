#!/bin/bash
set -euo pipefail
export ARCH=amd64 SOURCE_DIR=/ffmpeg TARGET_DIR=/usr/lib/jellyfin-ffmpeg DPKG_INSTALL_LIST=/ffmpeg/debian/jellyfin-ffmpeg8.install
export PATH=$TARGET_DIR/bin:$PATH PKG_CONFIG_PATH=$TARGET_DIR/lib/pkgconfig
export LD_LIBRARY_PATH=$TARGET_DIR/lib:$TARGET_DIR/lib/mfx:$TARGET_DIR/lib/xorg
export LDFLAGS="-Wl,--disable-new-dtags -Wl,-rpath=$TARGET_DIR/lib -L$TARGET_DIR/lib -lm"
export CXXFLAGS="-I$TARGET_DIR/include" CPPFLAGS="-I$TARGET_DIR/include" CFLAGS="-I$TARGET_DIR/include"
export CMAKE_POLICY_VERSION_MINIMUM=3.5
[[ "${NATIVE_BUILD_JOBS:?}" =~ ^([1-9]|1[0-6])$ ]] || exit 1
nproc(){ echo "$NATIVE_BUILD_JOBS"; }
git(){ if [ "$1" = clone ]; then python3 /locks/pinned-fetch.py git "$@"; else /usr/bin/git "$@"; fi; }
wget(){ python3 /locks/pinned-fetch.py wget "$@"; }

prepare_extra_common() {
    case ${ARCH} in
        'amd64')
            CROSS_PREFIX_OPT=""
            CROSS_OPT=""
            CMAKE_TOOLCHAIN_OPT=""
            MESON_CROSS_OPT=""
        ;;
        'arm64')
            CROSS_PREFIX_OPT="aarch64-linux-gnu-"
            CROSS_OPT="--host=aarch64-linux-gnu CC=aarch64-linux-gnu-gcc CXX=aarch64-linux-gnu-g++"
            CMAKE_TOOLCHAIN_OPT="-DCMAKE_TOOLCHAIN_FILE=${SOURCE_DIR}/toolchain-${ARCH}.cmake"
            MESON_CROSS_OPT="--cross-file=${SOURCE_DIR}/cross-${ARCH}.meson"
        ;;
    esac

    # ICONV
    pushd ${SOURCE_DIR}
    mkdir iconv
    pushd iconv
    iconv_ver="1.19"
    iconv_link="https://ftpmirror.gnu.org/gnu/libiconv/libiconv-${iconv_ver}.tar.gz"
    wget ${iconv_link} -O iconv.tar.gz
    tar xaf iconv.tar.gz
    pushd libiconv-${iconv_ver}
    ./configure \
        ${CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --disable-static \
        --enable-{shared,extra-encodings} \
        --with-pic
    make -j$(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/iconv
    echo "iconv${TARGET_DIR}/lib/libiconv.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd
    popd

    # ZLIB
    pushd ${SOURCE_DIR}
    git clone -b v1.3.2 --depth=1 https://github.com/madler/zlib.git
    pushd zlib
    CROSS_PREFIX=${CROSS_PREFIX_OPT} ./configure \
        --prefix=${TARGET_DIR} \
        --shared
    make -j$(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/zlib
    echo "zlib${TARGET_DIR}/lib/libz.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd

    # LIBXML2
    pushd ${SOURCE_DIR}
    libxml2_ver="v2.15.4"
    git clone -b ${libxml2_ver} --depth=1 https://github.com/GNOME/libxml2.git
    pushd libxml2
    ./autogen.sh \
        ${CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --disable-{static,maintainer-mode} \
        --enable-shared \
        --without-python
    make -j$(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/libxml2
    echo "libxml2${TARGET_DIR}/lib/libxml2.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd

    # FRIBIDI
    pushd ${SOURCE_DIR}
    git clone -b v1.0.16 --depth=1 https://github.com/fribidi/fribidi.git
    meson setup fribidi fribidi_build \
        ${MESON_CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --libdir=lib \
        --buildtype=release \
        --default-library=shared \
        -D{bin,docs,tests}=false
    meson configure fribidi_build
    ninja -j$(nproc) -C fribidi_build install
    cp -a ${TARGET_DIR}/lib/libfribidi.so* ${SOURCE_DIR}/fribidi
    echo "fribidi/libfribidi.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd

    # FREETYPE
    pushd ${SOURCE_DIR}
    git clone -b VER-2-14-3 --depth=1 https://github.com/freetype/freetype.git
    pushd freetype
    ./autogen.sh
    ./configure \
        ${CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --enable-shared \
        --disable-static
    make -j$(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/freetype
    echo "freetype${TARGET_DIR}/lib/libfreetype.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd

    # FONTCONFIG
    pushd ${SOURCE_DIR}
    git clone -b 2.17.1 --depth=1 https://chromium.googlesource.com/external/fontconfig
    meson setup fontconfig fontconfig_build \
        ${MESON_CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --sysconfdir=/etc \
        --localstatedir=/var \
        --libdir=lib \
        --buildtype=release \
        --wrap-mode=nofallback \
        --default-library=shared \
        -Diconv=enabled \
        -Dxml-backend=libxml2 \
        -D{cache-build,doc,tests,tools}=disabled
    meson configure fontconfig_build
    ninja -j$(nproc) -C fontconfig_build install
    cp -a ${TARGET_DIR}/lib/libfontconfig.so* ${SOURCE_DIR}/fontconfig
    echo "fontconfig/libfontconfig.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd

    # HARFBUZZ
    pushd ${SOURCE_DIR}
    git clone -b 14.2.1 --depth=1 https://github.com/harfbuzz/harfbuzz.git
    meson setup harfbuzz harfbuzz_build \
        ${MESON_CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --libdir=lib \
        --buildtype=release \
        --default-library=shared \
        -Dfreetype=enabled \
        -D{gpu,glib,gobject,cairo,chafa,icu}=disabled \
        -D{tests,introspection,docs,utilities}=disabled
    meson configure harfbuzz_build
    ninja -j$(nproc) -C harfbuzz_build install
    cp -a ${TARGET_DIR}/lib/libharfbuzz.so* ${SOURCE_DIR}/harfbuzz
    echo "harfbuzz/libharfbuzz.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd

    # UNIBREAK
    pushd ${SOURCE_DIR}
    git clone -b libunibreak_7_0 --depth=1 https://github.com/adah1972/libunibreak.git
    pushd libunibreak
    ./bootstrap
    ./configure \
        ${CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --enable-shared \
        --disable-static \
        --with-pic
    make -j$(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/libunibreak
    echo "libunibreak${TARGET_DIR}/lib/libunibreak.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd

    # LIBASS
    pushd ${SOURCE_DIR}
    git clone -b 0.17.5 --depth=1 https://github.com/libass/libass.git
    pushd libass
    ./autogen.sh
    ./configure \
        ${CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --disable-static \
        --enable-{shared,libunibreak} \
        --with-pic
    make -j$(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/libass
    echo "libass${TARGET_DIR}/lib/libass.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd

    # OGG
    pushd ${SOURCE_DIR}
    git clone -b v1.3.6 --depth=1 https://github.com/xiph/ogg.git
    pushd ogg
    ./autogen.sh
    ./configure \
        ${CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --disable-static \
        --enable-shared \
        --with-pic
    make -j$(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/ogg
    echo "ogg${TARGET_DIR}/lib/libogg.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd

    # THEORA
    pushd ${SOURCE_DIR}
    git clone -b v1.2.0 --depth=1 https://github.com/xiph/theora.git
    pushd theora
    # autotools: relax autoconf requirement to 2.69
    wget -q -O - https://github.com/xiph/theora/commit/3ae2669.patch | git apply
    ./autogen.sh
    ./configure \
        ${CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --disable-{static,examples,extra-programs,oggtest,vorbistest,spec,doc} \
        --enable-shared \
        --with-pic
    make -j$(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/theora
    echo "theora${TARGET_DIR}/lib/libtheora{enc,dec}.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd

    # FFTW3
    pushd ${SOURCE_DIR}
    mkdir fftw3
    pushd fftw3
    fftw3_ver="3.3.11"
    fftw3_link="https://fftw.org/fftw-${fftw3_ver}.tar.gz"
    wget ${fftw3_link} -O fftw3.tar.gz
    tar xaf fftw3.tar.gz
    pushd fftw-${fftw3_ver}
    if [ "${ARCH}" = "amd64" ]; then
        fftw3_optimizations="--enable-sse2 --enable-avx --enable-avx-128-fma --enable-avx2 --enable-avx512"
    else
        fftw3_optimizations="--enable-neon"
    fi
    ./configure \
        ${CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --disable-{static,doc} \
        --enable-{shared,single,threads,fortran} \
        $fftw3_optimizations \
        --with-our-malloc \
        --with-combined-threads \
        --with-incoming-stack-boundary=2
    make -j$(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/fftw3
    echo "fftw3${TARGET_DIR}/lib/libfftw3f.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd
    popd

    # CHROMAPRINT
    pushd ${SOURCE_DIR}
    git clone -b v1.6.0 --depth=1 https://github.com/acoustid/chromaprint.git
    pushd chromaprint
    echo "Libs.private: -lfftw3f -lstdc++" >> libchromaprint.pc.cmake
    echo "Cflags.private: -DCHROMAPRINT_NODLL" >> libchromaprint.pc.cmake
    mkdir build
    pushd build
    cmake \
        ${CMAKE_TOOLCHAIN_OPT} \
        -DCMAKE_INSTALL_PREFIX=${TARGET_DIR} \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=ON \
        -DBUILD_{TOOLS,TESTS}=OFF \
        -DFFT_LIB=fftw3f \
        ..
    make -j$(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/chromaprint
    echo "chromaprint${TARGET_DIR}/lib/libchromaprint.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd
    popd

    # ZIMG
    pushd ${SOURCE_DIR}
    git clone -b release-3.0.6 --recursive --depth=1 https://github.com/sekrit-twc/zimg.git
    pushd zimg
    ./autogen.sh
    ./configure --prefix=${TARGET_DIR} ${CROSS_OPT}
    make -j $(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/zimg
    echo "zimg${TARGET_DIR}/lib/libzimg.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd

    # DAV1D
    pushd ${SOURCE_DIR}
    git clone -b 1.5.4 --depth=1 https://github.com/videolan/dav1d.git
    meson setup dav1d dav1d_build \
        ${MESON_CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --libdir=lib \
        --buildtype=release \
        -Ddefault_library=shared \
        -Denable_asm=true \
        -Denable_{tools,tests,examples}=false
    meson configure dav1d_build
    ninja -j$(nproc) -C dav1d_build install
    cp -a ${TARGET_DIR}/lib/libdav1d.so* ${SOURCE_DIR}/dav1d
    echo "dav1d/libdav1d.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd

    # SVT-AV1
    pushd ${SOURCE_DIR}
    git clone -b v4.3.0 --depth=1 https://gitlab.com/AOMediaCodec/SVT-AV1.git
    pushd SVT-AV1
    mkdir build
    pushd build
    cmake \
        ${CMAKE_TOOLCHAIN_OPT} \
        -DCMAKE_INSTALL_PREFIX=${TARGET_DIR} \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=ON \
        -DBUILD_{TESTING,APPS,DEC}=OFF \
        ..
    make -j$(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/SVT-AV1
    echo "SVT-AV1${TARGET_DIR}/lib/libSvtAv1Enc.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd

    # FDK-AAC-STRIPPED
    pushd ${SOURCE_DIR}
    mkdir fdk-aac-stripped
    pushd fdk-aac-stripped
    fdk_aac_ver="stripped5"
    fdk_aac_link="https://gitlab.freedesktop.org/wtaymans/fdk-aac-stripped/-/archive/${fdk_aac_ver}/fdk-aac-stripped-${fdk_aac_ver}.tar.gz"
    wget ${fdk_aac_link} -O fdk-aac-stripped.tar.gz
    tar xaf fdk-aac-stripped.tar.gz
    pushd fdk-aac-stripped-${fdk_aac_ver}
    ./autogen.sh
    ./configure \
        --disable-{static,silent-rules} \
        --prefix=${TARGET_DIR} CFLAGS="-O3 -DNDEBUG" CXXFLAGS="-O3 -DNDEBUG" ${CROSS_OPT}
    make -j$(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/fdk-aac-stripped
    echo "fdk-aac-stripped${TARGET_DIR}/lib/libfdk-aac.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd
    popd

    # FFNVCODEC
    pushd ${SOURCE_DIR}
    git clone -b n12.0.16.1 --depth=1 https://github.com/FFmpeg/nv-codec-headers.git
    pushd nv-codec-headers
    make PREFIX=${TARGET_DIR} install
    popd
    popd

    # Install crossbuild dependencies
    apt-get install -y lib{udev,pciaccess,zstd,elf,expat1}-dev:${ARCH}

    # LIBDRM
    pushd ${SOURCE_DIR}
    mkdir libdrm
    pushd libdrm
    libdrm_ver="libdrm-2.4.131"
    libdrm_link="https://gitlab.freedesktop.org/mesa/libdrm/-/archive/${libdrm_ver}/libdrm-${libdrm_ver}.tar.gz"
    wget ${libdrm_link} -O libdrm.tar.gz
    tar xaf libdrm.tar.gz
    meson setup libdrm-${libdrm_ver} drm_build \
        ${MESON_CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --libdir=lib \
        --buildtype=release \
        -D{udev,tests,install-test-programs}=false \
        -D{amdgpu,radeon,intel}=enabled \
        -D{etnaviv,valgrind,freedreno,vc4,vmwgfx,nouveau,man-pages}=disabled
    meson configure drm_build
    ninja -j$(nproc) -C drm_build install
    cp -a ${TARGET_DIR}/lib/libdrm*.so* ${SOURCE_DIR}/libdrm
    cp ${TARGET_DIR}/share/libdrm/*.ids ${SOURCE_DIR}/libdrm
    echo "libdrm/libdrm*.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    echo "libdrm/*.ids usr/lib/jellyfin-ffmpeg/share/libdrm" >> ${DPKG_INSTALL_LIST}
    popd
    popd

    # LIBVA
    pushd ${SOURCE_DIR}
    git clone -b 2.24.1 --depth=1 https://github.com/intel/libva.git
    pushd libva
    if [ "${ARCH}" = "arm64" ]; then
        libva_drv_arch_path="/usr/lib/aarch64-linux-gnu/dri"
    else
        libva_drv_arch_path="/usr/lib/x86_64-linux-gnu/dri"
    fi
    sed -i "s#secure_getenv(\"LIBVA_DRIVERS_PATH\")#\"/usr/lib/jellyfin-ffmpeg/lib/dri:${libva_drv_arch_path}:/usr/lib/dri:/usr/local/lib/dri\"#g" va/va.c
    sed -i "s#secure_getenv(\"LIBVA_DRIVER_NAME\")#secure_getenv(\"LIBVA_DRIVER_NAME_JELLYFIN\")#g" va/va.c
    ./autogen.sh
    ./configure \
        ${CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --enable-drm \
        --disable-{glx,x11,wayland,docs}
    make -j$(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/intel
    echo "intel${TARGET_DIR}/lib/libva.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    echo "intel${TARGET_DIR}/lib/libva-drm.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd

    # Vulkan Headers
    pushd ${SOURCE_DIR}
    git clone -b v1.4.355 --depth=1 https://github.com/KhronosGroup/Vulkan-Headers.git
    pushd Vulkan-Headers
    mkdir build && pushd build
    cmake \
        ${CMAKE_TOOLCHAIN_OPT} \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=${TARGET_DIR} ..
    make -j$(nproc) && make install
    popd
    popd
    popd

    # Vulkan ICD Loader
    pushd ${SOURCE_DIR}
    git clone -b v1.4.355 --depth=1 https://github.com/KhronosGroup/Vulkan-Loader.git
    pushd Vulkan-Loader
    sed -i 's/memset(disable_struct, 0, sizeof.*);/& disable_struct->disable_all_implicit = 1;/' loader/loader_environment.c
    mkdir build && pushd build
    cmake \
        ${CMAKE_TOOLCHAIN_OPT} \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=${TARGET_DIR} \
        -DVULKAN_HEADERS_INSTALL_DIR="${TARGET_DIR}" \
        -DCMAKE_INSTALL_SYSCONFDIR=${TARGET_DIR}/share \
        -DCMAKE_INSTALL_DATADIR=${TARGET_DIR}/share \
        -DCMAKE_INSTALL_LIBDIR=lib \
        -DBUILD_TESTS=OFF \
        -DBUILD_WSI_{XCB,XLIB,XLIB_XRANDR,WAYLAND}_SUPPORT=OFF ..
    make -j$(nproc) && make install
    cp -a ${TARGET_DIR}/lib/libvulkan.so* ${SOURCE_DIR}/Vulkan-Loader
    echo "Vulkan-Loader/libvulkan.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd
    popd

    # SHADERC
    shaderc_ver="v2026.2"
    pushd ${SOURCE_DIR}
    git clone -b ${shaderc_ver} --depth=1 https://github.com/google/shaderc.git
    pushd shaderc
    ./utils/git-sync-deps
    shaderc_conf=$(echo -GNinja \
        -DCMAKE_BUILD_TYPE=Release \
        -DSHADERC_SKIP_{TESTS,EXAMPLES,COPYRIGHT_CHECK}=ON \
        -DENABLE_EXCEPTIONS=ON \
        -DSPIRV_SKIP_EXECUTABLES=ON \
        -DSPIRV_TOOLS_BUILD_STATIC=ON \
        -DBUILD_SHARED_LIBS=OFF)
    # Build native glslangValidator for crossbuild
    if [ "${ARCH}" != "amd64" ]; then
        mkdir glslang_build && pushd glslang_build
        cmake $shaderc_conf \
            -DENABLE_GLSLANG_BINARIES=ON ..
        ninja -j$(nproc) third_party/glslang/StandAlone/glslang
        cp third_party/glslang/StandAlone/glslangValidator ${TARGET_DIR}/bin
        popd
    fi
    # Build target shaderc
    mkdir shaderc_build && pushd shaderc_build
    cmake $shaderc_conf \
        ${CMAKE_TOOLCHAIN_OPT} \
        -DENABLE_GLSLANG_BINARIES=$([ "${ARCH}" = "amd64" ] && echo "ON" || echo "OFF") \
        -DCMAKE_INSTALL_PREFIX=${TARGET_DIR} ..
    ninja -j$(nproc)
    ninja install
    cp -a ${TARGET_DIR}/lib/libshaderc_shared.so* ${SOURCE_DIR}/shaderc
    echo "shaderc/libshaderc_shared* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd
    popd

    # LIBPLACEBO
    pushd ${SOURCE_DIR}
    git clone -b v7.360.1 --recursive --depth=1 https://github.com/haasn/libplacebo.git
    # Fix bit shift when importing P01x non-multiplane image
    git -C libplacebo apply ${SOURCE_DIR}/builder/patches/libplacebo/*.patch
    sed -i 's/env: python_env,//g' libplacebo/src/vulkan/meson.build
    meson setup libplacebo placebo_build \
        ${MESON_CROSS_OPT} \
        --prefix=${TARGET_DIR} \
        --libdir=lib \
        --buildtype=release \
        --default-library=shared \
        -Dvulkan=enabled \
        -Dvk-proc-addr=enabled \
        -Dvulkan-registry=${TARGET_DIR}/share/vulkan/registry/vk.xml \
        -Dshaderc=enabled \
        -Dglslang=disabled \
        -D{demos,tests,bench,fuzz}=false
    meson configure placebo_build
    ninja -j$(nproc) -C placebo_build install
    cp -a ${TARGET_DIR}/lib/libplacebo.so* ${SOURCE_DIR}/libplacebo
    echo "libplacebo/libplacebo* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
}


prepare_extra_common
    # AMF
    # https://www.ffmpeg.org/general.html#AMD-AMF_002fVCE
    pushd ${SOURCE_DIR}
    mkdir amf-headers
    pushd amf-headers
    amf_ver="1.5.2"
    amf_link="https://github.com/GPUOpen-LibrariesAndSDKs/AMF/releases/download/v${amf_ver}/AMF-headers-v${amf_ver}.tar.gz"
    wget ${amf_link} -O amf.tar.gz
    tar xaf amf.tar.gz
    pushd amf-headers-v${amf_ver}/AMF
    mkdir -p /usr/include/AMF
    mv * /usr/include/AMF
    popd
    popd
    popd

    # LIBVPL (dispatcher + header)
    # Provides VPL header and dispatcher (libvpl.so.2) for FFmpeg
    # Both MSDK and VPL runtime can be loaded by VPL dispatcher
    pushd ${SOURCE_DIR}
    git clone -b v2.17.0 --depth=1 https://github.com/intel/libvpl.git
    pushd libvpl
    sed -i 's|ParseEnvSearchPaths(ONEVPL_PRIORITY_PATH_VAR, searchDirList)|searchDirList.push_back("/usr/lib/jellyfin-ffmpeg/lib")|g' libvpl/src/mfx_dispatcher_vpl_loader.cpp
    mkdir build && pushd build
    cmake -DCMAKE_INSTALL_PREFIX=${TARGET_DIR} \
          -DCMAKE_INSTALL_BINDIR=${TARGET_DIR}/bin \
          -DCMAKE_INSTALL_LIBDIR=${TARGET_DIR}/lib \
          -DCMAKE_BUILD_TYPE=Release \
          -DBUILD_SHARED_LIBS=ON \
          -DINSTALL_{DEV,LIB}=ON \
          -DINSTALL_EXAMPLES=OFF \
          -DBUILD_{TESTS,EXAMPLES,EXPERIMENTAL}=OFF \
          ..
    make -j$(nproc) && make install && make install DESTDIR=${SOURCE_DIR}/intel
    echo "Libs.private: -lstdc++" >> ${TARGET_DIR}/lib/pkgconfig/vpl.pc
    echo "intel${TARGET_DIR}/lib/libvpl.so* usr/lib/jellyfin-ffmpeg/lib" >> ${DPKG_INSTALL_LIST}
    popd
    popd
    popd

