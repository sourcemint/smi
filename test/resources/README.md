
Generate `test.tar.bz2`
-----------------------

    mkdir sub
    echo "TEST" > sub/test.txt
    tar -cvf test.tar sub
    rm -Rf sub
    bzip2 -z test.tar
