type LinkingType {
    multi link objs -> AbstractDeleteTest;
}

abstract type AbstractDeleteTest {
    property name -> str;
}

type DeleteTest extending AbstractDeleteTest;

type DeleteTest2 extending AbstractDeleteTest;
